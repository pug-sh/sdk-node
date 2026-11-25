import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'
import { PartialSendError } from './batch.js'
import { BatchCreateResponseSchema, EventSchema } from './gen/sdk/events/v1/events_pb.js'
import {
  BatchIdentifyResponseSchema,
  type IdentifyRequest,
  IdentifyRequestSchema,
} from './gen/sdk/profiles/v1/profiles_pb.js'
import { createEventSink, createIdentifySink } from './transport.js'

it('warns with the reasons when the server drops events it does not name', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const batchCreate = async () =>
    create(BatchCreateResponseSchema, { accepted: 1, dropped: 3, droppedByReason: { a_reason: 2, b_reason: 1 } })
  await createEventSink({ batchCreate } as never).sendBatch([{}, {}, {}, {}] as never)
  expect(warn).toHaveBeenCalledWith('[Pug SDK] Server dropped 3 of 4 event(s): 2 a_reason, 1 b_reason.')
  warn.mockRestore()
})

it('throws the events the server refused, naming the first three', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const batchCreate = async () =>
    create(BatchCreateResponseSchema, {
      accepted: 2,
      dropped: 4,
      droppedByReason: { invalid_event: 4 },
      invalidEvents: [
        { index: 0, violations: ['v1', 'v2'] },
        { index: 2, violations: ['v3'] },
        { index: 3, violations: ['v4'] },
        { index: 4, violations: ['v5'] },
      ],
    })
  const batch = ['a', 'b', 'c', 'd', 'e', 'f'].map(kind => create(EventSchema, { kind }))
  await expect(createEventSink({ batchCreate } as never).sendBatch(batch)).rejects.toMatchObject({
    items: [batch[0], batch[2], batch[3], batch[4]],
    message: 'Server refused 4 of 6 event(s): "a": v1; v2 | "c": v3 | "d": v4 | and 1 more',
  })
  expect(warn).not.toHaveBeenCalled()
  warn.mockRestore()
})

describe('createIdentifySink', () => {
  const identifies = (...ids: string[]) => ids.map(externalId => create(IdentifyRequestSchema, { externalId }))
  const unimplemented = () => Promise.reject(new ConnectError('no such procedure', Code.Unimplemented))

  it('sends a batch with one BatchIdentify call', async () => {
    const batchIdentify = vi.fn(async () => create(BatchIdentifyResponseSchema, { accepted: 2 }))
    const identify = vi.fn()
    await createIdentifySink({ batchIdentify, identify } as never).sendBatch(identifies('u1', 'u2'))
    expect(batchIdentify).toHaveBeenCalledWith(expect.objectContaining({ identifies: identifies('u1', 'u2') }))
    expect(identify).not.toHaveBeenCalled()
  })

  it('throws the identifies BatchIdentify refused', async () => {
    const batchIdentify = async () =>
      create(BatchIdentifyResponseSchema, { accepted: 1, invalidIdentifies: [{ index: 1, violations: ['v1'] }] })
    const batch = identifies('u1', 'u2')
    await expect(createIdentifySink({ batchIdentify } as never).sendBatch(batch)).rejects.toMatchObject({
      items: [batch[1]],
      message: 'Server refused 1 of 2 identifies: "u2": v1',
    })
  })

  it('falls back to one Identify call each, for good, on a server without BatchIdentify', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const batchIdentify = vi.fn(unimplemented)
    const identify = vi.fn(async (_req: IdentifyRequest) => ({}))
    const sink = createIdentifySink({ batchIdentify, identify } as never)
    await sink.sendBatch(identifies('u1', 'u2'))
    await sink.sendBatch(identifies('u3'))
    expect(identify.mock.calls).toEqual(identifies('u1', 'u2', 'u3').map(req => [req]))
    expect(batchIdentify).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no BatchIdentify'))
    warn.mockRestore()
  })

  it('reports how many identifies the fallback delivered before one failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = new ConnectError('down', Code.Unavailable)
    const identify = vi.fn(async (req: IdentifyRequest) => {
      if (req.externalId === 'u2') {
        throw down
      }
      return {}
    })
    const sent = createIdentifySink({ batchIdentify: unimplemented, identify } as never).sendBatch(
      identifies('u1', 'u2', 'u3'),
    )
    await expect(sent).rejects.toBeInstanceOf(PartialSendError)
    await expect(sent).rejects.toMatchObject({ sent: 1, cause: down })
    expect(identify).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('keeps trying BatchIdentify when Identify is unrouted too, as behind a proxy with no server up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const batchIdentify = vi.fn(unimplemented)
    const sink = createIdentifySink({ batchIdentify, identify: unimplemented } as never)
    await expect(sink.sendBatch(identifies('u1'))).rejects.toMatchObject({
      sent: 0,
      cause: { code: Code.Unimplemented },
    })
    await expect(sink.sendBatch(identifies('u2'))).rejects.toBeInstanceOf(PartialSendError)
    expect(batchIdentify).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('leaves any other BatchIdentify error to the batch transport', async () => {
    const down = new ConnectError('down', Code.Unavailable)
    const identify = vi.fn()
    const sent = createIdentifySink({ batchIdentify: () => Promise.reject(down), identify } as never).sendBatch(
      identifies('u1'),
    )
    await expect(sent).rejects.toBe(down)
    expect(identify).not.toHaveBeenCalled()
  })
})
