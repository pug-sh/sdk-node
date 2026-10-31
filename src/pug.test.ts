import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'
import { PugError } from './errors.js'
import type { IdentifyRequest } from './gen/sdk/profiles/v1/profiles_pb.js'
import { Pug } from './pug.js'

// endpoint is never dialed: no valid event is enqueued and the buffer is empty at close().
const newClient = () => new Pug({ apiKey: 'prv_test', endpoint: 'http://localhost:1' })

// Swaps the identify queue for an array of what it would have been handed.
const queuedIdentifies = (pug: Pug): IdentifyRequest[] => {
  const queued: IdentifyRequest[] = []
  ;(pug as unknown as { identifyQueue: unknown }).identifyQueue = { send: (req: IdentifyRequest) => queued.push(req) }
  return queued
}

describe('Pug', () => {
  it('requires an apiKey', () => {
    // @ts-expect-error testing runtime guard
    expect(() => new Pug({ endpoint: 'http://localhost:1' })).toThrow(/apiKey/)
  })

  it('track() is throw-free on invalid distinctId', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pug = newClient()
    expect(() => pug.track('', 'my.custom', { a: 1 })).not.toThrow()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('warns and drops track() after close()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pug = newClient()
    await pug.close()
    expect(() => pug.track('user_1', 'my.custom')).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('close() resolves on an empty buffer', async () => {
    await expect(newClient().close()).resolves.toBeUndefined()
  })

  it('rejects an apiKey that is not a private (prv_) key', () => {
    expect(() => new Pug({ apiKey: 'pub_test', endpoint: 'http://localhost:1' })).toThrow(/private key/)
  })

  it('identify() is throw-free and logs on invalid externalId', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pug = newClient()
    const queued = queuedIdentifies(pug)
    expect(() => pug.identify('')).not.toThrow()
    expect(err).toHaveBeenCalled()
    expect(queued).toHaveLength(0)
    err.mockRestore()
  })

  it('identify() validates client-side and drops without queueing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pug = newClient()
    const queued = queuedIdentifies(pug)
    // anonymousId must match ^anon-; an invalid value fails protovalidate before it is queued.
    expect(() => pug.identify('user_1', undefined, { anonymousId: 'nope' })).not.toThrow()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Invalid identify request'))
    expect(queued).toHaveLength(0)
    err.mockRestore()
  })

  // protovalidate doesn't look inside traits, and a non-object would be sent as an empty Struct.
  it.each([['{"plan":"pro"}'], [['pro']], [new Date(0)]])('identify() drops traits %j', traits => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pug = newClient()
    // @ts-expect-error testing runtime guard
    expect(() => pug.identify('user_1', traits)).not.toThrow()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('traits must be a plain object'))
    err.mockRestore()
  })

  it('identify() queues the request', () => {
    const pug = newClient()
    const queued = queuedIdentifies(pug)
    pug.identify('user_1', { plan: 'pro' }, { anonymousId: 'anon-1', deviceId: 'device-1' })
    expect(queued).toEqual([
      expect.objectContaining({
        externalId: 'user_1',
        traits: { plan: 'pro' },
        anonymousId: 'anon-1',
        deviceId: 'device-1',
      }),
    ])
  })

  it('identify() queues a copy the caller can no longer change', () => {
    const pug = newClient()
    const queued = queuedIdentifies(pug)
    const traits = { plan: 'free', limits: { seats: 1 } }
    pug.identify('user_1', traits)
    traits.plan = 'pro'
    traits.limits.seats = 5
    expect(queued[0]?.traits).toEqual({ plan: 'free', limits: { seats: 1 } })
  })

  it('identify() skips a trait holding NaN or Infinity and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pug = newClient()
    const queued = queuedIdentifies(pug)
    pug.identify('user_1', { ratio: Number.NaN, stats: { max: Number.POSITIVE_INFINITY }, plan: 'pro' })
    expect(queued[0]?.traits).toEqual({ plan: 'pro' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"ratio"'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"stats"'))
    warn.mockRestore()
  })

  // NATS can't carry it, so it would fail every send of its batch.
  it('identify() drops an identify over 900 KiB without blocking smaller ones', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pug = newClient()
    const queued = queuedIdentifies(pug)
    pug.identify('user_big', { blob: 'x'.repeat(900 << 10) })
    pug.identify('user_small', { blob: 'x'.repeat(899 << 10) })
    expect(queued.map(req => req.externalId)).toEqual(['user_small'])
    expect(err).toHaveBeenCalledWith(expect.stringContaining('921600-byte limit'))
    err.mockRestore()
  })

  it('warns and drops identify() after close()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pug = newClient()
    await pug.close()
    expect(() => pug.identify('user_1')).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('identify() called after close()'))
    warn.mockRestore()
  })

  it('profiles.list() surfaces stream errors as PugError, not a raw ConnectError', async () => {
    const pug = newClient()
    // Inject a fake streaming client that throws as soon as iteration begins.
    ;(pug as unknown as { rpc: unknown }).rpc = {
      profiles: {
        list: async function* () {
          throw new ConnectError('denied', Code.PermissionDenied)
        },
      },
    }
    let caught: unknown
    try {
      await pug.profiles.list().next()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PugError)
    expect((caught as PugError).code).toBe(Code.PermissionDenied)
  })

  it('track() carries options through to the event', () => {
    const pug = newClient()
    const sent: { autoProperties: Record<string, { value: { value: unknown } }>; occurTime: unknown }[] = []
    ;(pug as unknown as { eventQueue: unknown }).eventQueue = { send: (e: never) => sent.push(e) }

    pug.track('user_1', 'my.custom', undefined, { timestamp: 0, location: { country: 'DE' } })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.autoProperties.$country.value.value).toBe('DE')
    expect(sent[0]?.occurTime).toMatchObject({ seconds: 0n })
  })

  it("track() drops a distinctId with the reserved 'cookieless-' prefix", () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pug = newClient()
    const sent: unknown[] = []
    ;(pug as unknown as { eventQueue: unknown }).eventQueue = { send: (e: never) => sent.push(e) }
    pug.track('cookieless-abc', 'my.custom')
    expect(sent).toHaveLength(0)
    expect(err).toHaveBeenCalledWith(expect.stringContaining("reserved 'cookieless-' prefix"))
    err.mockRestore()
  })

  it('track() drops an event over 900 KiB without blocking smaller ones', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pug = newClient()
    const sent: { distinctId: string }[] = []
    ;(pug as unknown as { eventQueue: unknown }).eventQueue = { send: (e: never) => sent.push(e) }
    const props = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, 'x'.repeat(1000)]))
    pug.track('user_1', 'my.custom', props(908)) // about 921,700 bytes
    pug.track('user_2', 'my.custom', props(907)) // about 920,700 bytes
    expect(sent.map(e => e.distinctId)).toEqual(['user_2'])
    expect(err).toHaveBeenCalledWith(expect.stringContaining('921600-byte limit'))
    err.mockRestore()
  })

  it("identify() rejects an externalId with the reserved 'cookieless-' prefix", () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    newClient().identify('cookieless-abc')
    expect(err).toHaveBeenCalledWith(expect.stringContaining("reserved 'cookieless-' prefix"))
    err.mockRestore()
  })

  it('passes reads through to the RPC', async () => {
    const pug = newClient()
    const getProfileSessions = vi.fn(async () => ({ sessions: [] }))
    const get = vi.fn(async () => ({ profile: { id: 'p1' } }))
    ;(pug as unknown as { rpc: unknown }).rpc = { activity: { getProfileSessions }, profiles: { get } }
    await expect(pug.activity.profileSessions({ distinctId: 'p1', includeBots: true })).resolves.toEqual({
      sessions: [],
    })
    await expect(pug.profiles.get('p1', { includeBots: true })).resolves.toEqual({ id: 'p1' })
    expect(getProfileSessions).toHaveBeenCalledWith({ distinctId: 'p1', includeBots: true })
    expect(get).toHaveBeenCalledWith({ id: 'p1', includeBots: true })
  })
})
