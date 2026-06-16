import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'
import { PugError } from './errors.js'
import { Pug } from './pug.js'

// baseUrl is never dialed: no valid event is enqueued and the buffer is empty at close().
const newClient = () => new Pug({ apiKey: 'prv_test', baseUrl: 'http://localhost:1' })

describe('Pug', () => {
  it('requires an apiKey', () => {
    // @ts-expect-error testing runtime guard
    expect(() => new Pug({ baseUrl: 'http://localhost:1' })).toThrow(/apiKey/)
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
    expect(() => new Pug({ apiKey: 'pub_test', baseUrl: 'http://localhost:1' })).toThrow(/private key/)
  })

  it('identify() is throw-free and logs on invalid externalId', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pug = newClient()
    await expect(pug.identify('')).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('identify() validates client-side and drops without throwing or dialing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pug = newClient()
    // anonymousId must match ^anon-; an invalid value fails protovalidate before any network call.
    await expect(pug.identify('user_1', undefined, { anonymousId: 'nope' })).resolves.toBeUndefined()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Invalid identify request'))
    err.mockRestore()
  })

  it('warns and drops identify() after close()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pug = newClient()
    await pug.close()
    await expect(pug.identify('user_1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
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
})
