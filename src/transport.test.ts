import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'
import { PartialSendError } from './batch.js'
import { type IdentifyRequest, IdentifyRequestSchema } from './gen/sdk/profiles/v1/profiles_pb.js'
import { createEventSink, createIdentifySink } from './transport.js'

it('warns with the reasons when the server drops events', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const batchCreate = async () => ({ accepted: 1, dropped: 2, droppedByReason: { day_out_of_range: 2 } })
  await createEventSink({ batchCreate } as never).sendBatch([{}, {}, {}] as never)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 2 of 3'), { day_out_of_range: 2 })
  warn.mockRestore()
})

describe('createIdentifySink', () => {
  const identifies = (...ids: string[]) => ids.map(externalId => create(IdentifyRequestSchema, { externalId }))
  const unimplemented = () => Promise.reject(new ConnectError('no such procedure', Code.Unimplemented))

  it('sends a batch with one BatchIdentify call', async () => {
    const batchIdentify = vi.fn(async () => ({ accepted: 2 }))
    const identify = vi.fn()
    await createIdentifySink({ batchIdentify, identify } as never).sendBatch(identifies('u1', 'u2'))
    expect(batchIdentify).toHaveBeenCalledWith(expect.objectContaining({ identifies: identifies('u1', 'u2') }))
    expect(identify).not.toHaveBeenCalled()
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
