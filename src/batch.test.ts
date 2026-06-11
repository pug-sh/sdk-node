import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'
import { createBatchedTransport, type EventSink } from './batch.js'

// biome-ignore lint: tests use opaque stand-in events
const ev = (id: number) => ({ id }) as any

function setup(
  opts: {
    send?: EventSink['sendBatch']
    config?: Partial<{ maxSize: number; maxWaitMs: number; maxQueueSize: number }>
  } = {},
) {
  const sent: unknown[][] = []
  const errors: { err: unknown; events: unknown[] }[] = []
  const sink: EventSink = {
    sendBatch:
      opts.send ??
      (async b => {
        sent.push(b)
      }),
  }
  const t = createBatchedTransport(
    sink,
    opts.config ?? { maxSize: 3, maxWaitMs: 10_000, maxQueueSize: 5 },
    (err, events) => errors.push({ err, events }),
  )
  return { t, sent, errors }
}

describe('createBatchedTransport', () => {
  it('flushes when maxSize is reached', async () => {
    const { t, sent } = setup()
    t.send(ev(1))
    t.send(ev(2))
    expect(sent).toHaveLength(0)
    t.send(ev(3))
    await t.flush()
    expect(sent).toEqual([[ev(1), ev(2), ev(3)]])
  })

  it('flush() sends the current buffer', async () => {
    const { t, sent } = setup()
    t.send(ev(1))
    await t.flush()
    expect(sent).toEqual([[ev(1)]])
  })

  it('dead-letters permanent (non-Connect) errors via onError', async () => {
    const { t, errors } = setup({
      send: async () => {
        throw new Error('boom')
      },
    })
    t.send(ev(1))
    await t.flush()
    expect(errors).toHaveLength(1)
    expect(errors[0].events).toEqual([ev(1)])
  })

  it('retries transient errors (events stay queued)', async () => {
    let calls = 0
    const sent: unknown[][] = []
    const sink: EventSink = {
      sendBatch: async b => {
        calls++
        if (calls === 1) {
          throw new ConnectError('unavailable', Code.Unavailable)
        }
        sent.push(b)
      },
    }
    const errors: unknown[] = []
    const t = createBatchedTransport(sink, { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 5 }, e => errors.push(e))
    t.send(ev(1))
    await t.flush() // attempt 1 → transient, re-queued
    expect(sent).toHaveLength(0)
    expect(errors).toHaveLength(0)
    await t.flush() // attempt 2 → success
    expect(sent).toEqual([[ev(1)]])
  })

  it('drops oldest on overflow and reports it', async () => {
    const { t, errors } = setup({ config: { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 2 } })
    t.send(ev(1))
    t.send(ev(2))
    t.send(ev(3)) // overflow → drop ev(1)
    expect(errors[0].events).toEqual([ev(1)])
  })

  it('close() drains and rejects further sends', async () => {
    const { t, sent, errors } = setup()
    t.send(ev(1))
    await t.close()
    expect(sent).toEqual([[ev(1)]])
    t.send(ev(2))
    expect(errors.at(-1)?.events).toEqual([ev(2)])
  })

  it('flushes on the maxWaitMs interval', async () => {
    vi.useFakeTimers()
    try {
      const sent: unknown[][] = []
      const sink: EventSink = {
        sendBatch: async b => {
          sent.push(b as unknown[])
        },
      }
      const t = createBatchedTransport(sink, { maxSize: 99, maxWaitMs: 50, maxQueueSize: 99 }, () => {})
      t.send(ev(1))
      expect(sent).toHaveLength(0) // below maxSize: waiting on the timer
      await vi.advanceTimersByTimeAsync(50)
      expect(sent).toEqual([[ev(1)]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('splits a buffer larger than maxSize into <= maxSize chunks', async () => {
    let attempt = 0
    const sent: unknown[][] = []
    const sink: EventSink = {
      sendBatch: async b => {
        attempt++
        if (attempt === 1) {
          throw new ConnectError('unavailable', Code.Unavailable) // transient → re-queue [1,2]
        }
        sent.push(b as unknown[])
      },
    }
    const t = createBatchedTransport(sink, { maxSize: 2, maxWaitMs: 10_000, maxQueueSize: 99 }, () => {})
    t.send(ev(1))
    t.send(ev(2)) // hits maxSize → auto-flush → transient → [1,2] re-queued
    await new Promise(r => setTimeout(r, 0)) // let the failed attempt settle
    t.send(ev(3)) // buffer is now [1,2,3] → auto-flush splits into [1,2] + [3]
    await t.flush()
    expect(sent).toEqual([[ev(1), ev(2)], [ev(3)]])
  })

  it('clamps an invalid maxSize to the default and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { t, sent } = setup({ config: { maxSize: 0, maxWaitMs: 10_000, maxQueueSize: 5 } })
    t.send(ev(1)) // maxSize fell back to default 100, so a single event does not auto-flush
    expect(sent).toHaveLength(0)
    await t.flush()
    expect(sent).toEqual([[ev(1)]])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('dead-letters (does not re-queue) a transient failure during close()', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const errors: { events: unknown[] }[] = []
    const sink: EventSink = {
      sendBatch: async () => {
        throw new ConnectError('unavailable', Code.Unavailable)
      },
    }
    const t = createBatchedTransport(sink, { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 5 }, (_e, events) =>
      errors.push({ events }),
    )
    t.send(ev(1))
    await t.close() // closed → transient takes the dead-letter branch, not the retry branch
    expect(errors).toHaveLength(1)
    expect(errors[0].events).toEqual([ev(1)])
    err.mockRestore()
  })

  it('contains a throwing onError callback instead of propagating it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink: EventSink = { sendBatch: async () => {} }
    const t = createBatchedTransport(sink, { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 1 }, () => {
      throw new Error('callback boom')
    })
    t.send(ev(1))
    expect(() => t.send(ev(2))).not.toThrow() // overflow fires onError, which throws — must be contained
    err.mockRestore()
  })
})
