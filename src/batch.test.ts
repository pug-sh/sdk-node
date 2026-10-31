import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it, vi } from 'vitest'
import { createBatchedTransport, IDENTIFY_NAMES, PartialSendError, resolveBatchConfig, type Sink } from './batch.js'

// biome-ignore lint: tests use opaque stand-in events
const ev = (id: number) => ({ id }) as any

function setup(
  opts: {
    send?: Sink<unknown>['sendBatch']
    config?: Partial<{ maxSize: number; maxWaitMs: number; maxQueueSize: number }>
  } = {},
) {
  const sent: unknown[][] = []
  const errors: { err: unknown; events: unknown[] }[] = []
  const sink: Sink<unknown> = {
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
    const sink: Sink<unknown> = {
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
      const sink: Sink<unknown> = {
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
    const sink: Sink<unknown> = {
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
    t.send(ev(3)) // buffer is now [1,2,3] → the flush splits it into [1,2] + [3]
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
    const sink: Sink<unknown> = {
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

  it('stops at a chunk that fails transiently, keeping it and the chunks after it queued in order', async () => {
    let failing = true
    const attempts: unknown[][] = []
    const sink: Sink<unknown> = {
      sendBatch: async b => {
        attempts.push(b)
        if (failing) {
          throw new ConnectError('unavailable', Code.Unavailable)
        }
      },
    }
    const t = createBatchedTransport(sink, { maxSize: 2, maxWaitMs: 10_000, maxQueueSize: 99 }, () => {})
    t.send(ev(1))
    t.send(ev(2))
    t.send(ev(3))
    await t.flush()
    expect(attempts).toEqual([[ev(1), ev(2)]])
    failing = false
    await t.flush()
    expect(attempts.slice(1)).toEqual([[ev(1), ev(2)], [ev(3)]])
  })

  it('runs one flush at a time, so a retry goes out ahead of newer items', async () => {
    const hung: (() => void)[] = []
    const sent: unknown[][] = []
    const sink: Sink<unknown> = {
      sendBatch: async b => {
        if (hung.length === 0) {
          await new Promise<void>(resolve => hung.push(resolve))
          throw new ConnectError('unavailable', Code.Unavailable)
        }
        sent.push(b)
      },
    }
    const t = createBatchedTransport(sink, { maxSize: 2, maxWaitMs: 10_000, maxQueueSize: 99 }, () => {})
    t.send(ev(1))
    t.send(ev(2))
    await new Promise(r => setTimeout(r, 0))
    expect(hung).toHaveLength(1)
    t.send(ev(3))
    t.send(ev(4))
    await new Promise(r => setTimeout(r, 0))
    expect(hung).toHaveLength(1)
    expect(sent).toHaveLength(0)
    hung[0]?.()
    await t.flush()
    expect(sent).toEqual([
      [ev(1), ev(2)],
      [ev(3), ev(4)],
    ])
  })

  it('contains a throwing onError callback instead of propagating it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink: Sink<unknown> = { sendBatch: async () => {} }
    const t = createBatchedTransport(sink, { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 1 }, () => {
      throw new Error('callback boom')
    })
    t.send(ev(1))
    expect(() => t.send(ev(2))).not.toThrow() // overflow fires onError, which throws; must be contained
    err.mockRestore()
  })

  it('retries only what a partial send left unsent', async () => {
    let calls = 0
    const { t, sent, errors } = setup({
      config: { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 99 },
      send: async b => {
        calls++
        if (calls === 1) {
          throw new PartialSendError(2, new ConnectError('unavailable', Code.Unavailable))
        }
        sent.push(b)
      },
    })
    t.send(ev(1))
    t.send(ev(2))
    t.send(ev(3))
    await t.flush() // ev(1) and ev(2) delivered before the failure; ev(3) is re-queued
    await t.flush()
    expect(sent).toEqual([[ev(3)]])
    expect(errors).toHaveLength(0)
  })

  it('dead-letters only what a partial send left undelivered, with the underlying error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refused = new ConnectError('bad', Code.InvalidArgument)
    const { t, errors } = setup({
      config: { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 99 },
      send: async () => {
        throw new PartialSendError(1, refused)
      },
    })
    t.send(ev(1))
    t.send(ev(2))
    t.send(ev(3))
    await t.flush()
    expect(errors).toEqual([{ err: refused, events: [ev(2), ev(3)] }])
    err.mockRestore()
  })

  it('cuts a request before its items pass maxBytes', async () => {
    const sent: unknown[][] = []
    const t = createBatchedTransport<{ id: number; size: number }>(
      { sendBatch: async b => sent.push(b) },
      { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 99 },
      () => {},
      { sizeOf: item => item.size, maxBytes: 4 << 20 },
    )
    const items = [
      { id: 1, size: 3 << 20 },
      { id: 2, size: 1 << 20 }, // exactly 4 MiB with the first: still one request
      { id: 3, size: 1 },
      { id: 4, size: 2 << 20 },
    ]
    for (const item of items) {
      t.send(item)
    }
    await t.flush()
    expect(sent).toEqual([items.slice(0, 2), items.slice(2)])
  })

  it('names what it carries in its logs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = createBatchedTransport(
      {
        sendBatch: async () => {
          throw new ConnectError('bad', Code.InvalidArgument)
        },
      },
      { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 99 },
      () => {},
      { names: IDENTIFY_NAMES },
    )
    t.send(ev(1))
    t.send(ev(2))
    await t.flush()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('2 identifies dropped'), expect.any(ConnectError))
    err.mockRestore()
  })

  it('resolves a resolved config without warning again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cfg = resolveBatchConfig({ maxSize: 5000, maxWaitMs: -1 })
    expect(cfg).toEqual({ maxSize: 1000, maxWaitMs: 5000, maxQueueSize: 10_000 })
    expect(warn).toHaveBeenCalledTimes(2)
    createBatchedTransport({ sendBatch: async () => {} }, cfg)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('sends an item bigger than maxBytes on its own', async () => {
    const sent: unknown[][] = []
    const t = createBatchedTransport<{ id: number; size: number }>(
      { sendBatch: async b => sent.push(b) },
      { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 99 },
      () => {},
      { sizeOf: item => item.size, maxBytes: 10 },
    )
    const items = [
      { id: 1, size: 15 },
      { id: 2, size: 1 },
      { id: 3, size: 15 },
    ]
    for (const item of items) {
      t.send(item)
    }
    await t.flush()
    expect(sent).toEqual(items.map(item => [item]))
  })

  it('close() waits for a request already in flight', async () => {
    const hung: (() => void)[] = []
    const sent: unknown[][] = []
    const { t } = setup({
      config: { maxSize: 1, maxWaitMs: 10_000, maxQueueSize: 99 },
      send: async b => {
        await new Promise<void>(resolve => hung.push(resolve))
        sent.push(b)
      },
    })
    t.send(ev(1))
    await new Promise(r => setTimeout(r, 0))
    expect(hung).toHaveLength(1)
    let closed = false
    const closing = t.close().then(() => {
      closed = true
    })
    await new Promise(r => setTimeout(r, 0))
    expect(closed).toBe(false)
    hung[0]?.()
    await closing
    expect(sent).toEqual([[ev(1)]])
  })

  it('on close, reports what a transient error left unsent instead of sending the rest', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const down = new ConnectError('down', Code.Unavailable)
    const attempts: unknown[][] = []
    const { t, errors } = setup({
      config: { maxSize: 2, maxWaitMs: 10_000, maxQueueSize: 99 },
      send: async b => {
        attempts.push(b)
        throw new PartialSendError(1, down)
      },
    })
    for (let i = 1; i <= 4; i++) {
      t.send(ev(i))
    }
    await t.close()
    expect(attempts).toEqual([[ev(1), ev(2)]])
    expect(errors).toEqual([{ err: down, events: [ev(2), ev(3), ev(4)] }])
    err.mockRestore()
  })

  it('retries a transient failure after maxWaitMs, with no new items to trigger it', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const sent: unknown[][] = []
      const { t } = setup({
        config: { maxSize: 99, maxWaitMs: 50, maxQueueSize: 99 },
        send: async b => {
          calls++
          if (calls === 1) {
            throw new ConnectError('unavailable', Code.Unavailable)
          }
          sent.push(b)
        },
      })
      t.send(ev(1))
      await t.flush()
      expect(sent).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(50)
      expect(sent).toEqual([[ev(1)]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits maxWaitMs before retrying, even when new items reach maxSize', async () => {
    vi.useFakeTimers()
    try {
      let failing = true
      const attempts: unknown[][] = []
      const { t } = setup({
        config: { maxSize: 2, maxWaitMs: 50, maxQueueSize: 99 },
        send: async b => {
          attempts.push(b)
          if (failing) {
            throw new ConnectError('unavailable', Code.Unavailable)
          }
        },
      })
      t.send(ev(1))
      t.send(ev(2))
      await t.flush()
      failing = false
      t.send(ev(3))
      t.send(ev(4))
      await vi.advanceTimersByTimeAsync(10)
      expect(attempts).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(50)
      expect(attempts.slice(1)).toEqual([
        [ev(1), ev(2)],
        [ev(3), ev(4)],
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a re-queue within maxQueueSize, reporting the oldest as overflow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hung: (() => void)[] = []
    const sent: unknown[][] = []
    const { t, errors } = setup({
      config: { maxSize: 99, maxWaitMs: 10_000, maxQueueSize: 3 },
      send: async b => {
        if (hung.length === 0) {
          await new Promise<void>(resolve => hung.push(resolve))
          throw new ConnectError('unavailable', Code.Unavailable)
        }
        sent.push(b)
      },
    })
    t.send(ev(1))
    t.send(ev(2))
    const draining = t.flush()
    await new Promise(r => setTimeout(r, 0))
    t.send(ev(3))
    t.send(ev(4))
    hung[0]?.()
    await draining
    expect(errors).toEqual([
      { err: expect.objectContaining({ message: 'queue overflow: dropped oldest 1 event' }), events: [ev(1)] },
    ])
    await t.flush()
    expect(sent).toEqual([[ev(2), ev(3), ev(4)]])
    warn.mockRestore()
  })

  it('re-queues a backlog too big to spread into a call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let failing = true
    let delivered = 0
    const { t, errors } = setup({
      config: { maxSize: 1000, maxWaitMs: 10_000, maxQueueSize: 300_000 },
      send: async b => {
        if (failing) {
          throw new ConnectError('unavailable', Code.Unavailable)
        }
        delivered += b.length
      },
    })
    for (let i = 0; i < 300_000; i++) {
      t.send(ev(i))
    }
    await t.flush()
    failing = false
    await t.flush()
    expect(delivered).toBe(300_000)
    expect(errors).toHaveLength(0)
    warn.mockRestore()
  })
})
