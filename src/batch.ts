import { ConnectError } from '@connectrpc/connect'
import type { Event } from './gen/sdk/events/v1/events_pb.js'
import { log } from './logger.js'

export interface BatchConfig {
  readonly maxSize: number
  readonly maxWaitMs: number
  readonly maxQueueSize: number
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxSize: 100,
  maxWaitMs: 5000,
  maxQueueSize: 10_000,
}

/** Hard cap per BatchCreate request enforced by the events proto. */
const MAX_BATCH = 1000

// gRPC codes that indicate client errors or server rejections retrying cannot fix:
// InvalidArgument(3), NotFound(5), AlreadyExists(6), PermissionDenied(7),
// FailedPrecondition(9), Unimplemented(12), Unauthenticated(16).
const PERMANENT_GRPC_CODES = new Set([3, 5, 6, 7, 9, 12, 16])

const isPermanentError = (err: unknown): boolean => {
  if (err instanceof ConnectError) {
    return PERMANENT_GRPC_CODES.has(err.code)
  }
  // Non-Connect errors (TypeError, etc.) are code/data bugs retrying can't fix.
  return true
}

export interface EventSink {
  sendBatch: (events: Event[]) => Promise<unknown>
}

export type OnError = (err: unknown, events: Event[]) => void

/**
 * In-memory batching transport. Events accumulate and flush on a size or interval
 * trigger; transient send failures keep events queued for retry, permanent failures
 * dead-letter via `onError`. `close()` drains and reports anything still undelivered.
 */
export const createBatchedTransport = (
  inner: EventSink,
  partialConfig?: Partial<BatchConfig>,
  onError: OnError = () => {},
) => {
  // A throwing onError must never abort the flush loop or the drain — that would drop the
  // remaining chunks with neither a log nor a callback. Contain it here.
  const safeOnError = (err: unknown, events: Event[]): void => {
    try {
      onError(err, events)
    } catch (cbErr) {
      log.error(`onError callback threw; ${events.length} event(s) may be lost:`, cbErr)
    }
  }

  const cfg = { ...DEFAULT_BATCH_CONFIG, ...partialConfig }
  const validated = (name: string, value: number, min: number, fallback: number): number => {
    // Counts (min >= 1) must be integers; a duration (maxWaitMs, min 0) may be fractional.
    if (min >= 1 && !Number.isInteger(value)) {
      log.warn(`batch.${name} must be an integer, using default.`)
      return fallback
    }
    if (value < min) {
      log.warn(`batch.${name} must be >= ${min}, using default.`)
      return fallback
    }
    return value
  }

  const requestedMaxSize = validated('maxSize', cfg.maxSize, 1, DEFAULT_BATCH_CONFIG.maxSize)
  if (requestedMaxSize > MAX_BATCH) {
    log.warn(`batch.maxSize exceeds the ${MAX_BATCH}-event proto cap, clamping to ${MAX_BATCH}.`)
  }
  const maxSize = Math.min(MAX_BATCH, requestedMaxSize)
  const maxWaitMs = validated('maxWaitMs', cfg.maxWaitMs, 0, DEFAULT_BATCH_CONFIG.maxWaitMs)
  const maxQueueSize = validated('maxQueueSize', cfg.maxQueueSize, 1, DEFAULT_BATCH_CONFIG.maxQueueSize)

  let buffer: Event[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> = Promise.resolve()
  let closed = false

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const scheduleFlush = () => {
    if (timer !== null || closed) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, maxWaitMs)
    timer.unref?.()
  }

  const sendChunk = async (chunk: Event[]): Promise<void> => {
    try {
      await inner.sendBatch(chunk)
    } catch (err) {
      if (isPermanentError(err)) {
        log.error(`Permanent error, ${chunk.length} event(s) dropped (will NOT retry):`, err)
        safeOnError(err, chunk)
      } else if (closed) {
        log.error(`Client closed, ${chunk.length} event(s) dropped after transient error:`, err)
        safeOnError(err, chunk)
      } else {
        log.warn('Transient error sending batch, will retry:', err)
        buffer.unshift(...chunk)
        scheduleFlush()
      }
    }
  }

  const flush = (): Promise<void> => {
    clearTimer()
    if (buffer.length === 0) {
      return inflight
    }
    const batch = buffer.splice(0, buffer.length)
    const chunks: Event[][] = []
    for (let i = 0; i < batch.length; i += maxSize) {
      chunks.push(batch.slice(i, i + maxSize))
    }
    const run = (async () => {
      for (const chunk of chunks) {
        await sendChunk(chunk)
      }
    })()
    // sendChunk is total (never rejects), but chain on both settle paths so a future
    // throw in run can't leave inflight rejected — close() awaits inflight to drain.
    inflight = inflight.then(
      () => run,
      () => run,
    )
    return run
  }

  return {
    send: (event: Event): void => {
      if (closed) {
        safeOnError(new Error('client is closed'), [event])
        return
      }
      if (buffer.length >= maxQueueSize) {
        const dropped = buffer.shift()
        if (dropped) {
          log.warn('Queue full, dropping oldest event')
          safeOnError(new Error('queue overflow: dropped oldest event'), [dropped])
        }
      }
      buffer.push(event)
      if (buffer.length >= maxSize) {
        void flush()
      } else {
        scheduleFlush()
      }
    },

    flush,

    close: async (): Promise<void> => {
      closed = true
      clearTimer()
      await flush()
      await inflight
      if (buffer.length > 0) {
        const undelivered = buffer.splice(0, buffer.length)
        safeOnError(new Error(`client closed with ${undelivered.length} undelivered event(s)`), undelivered)
      }
    },
  }
}

export type BatchedTransport = ReturnType<typeof createBatchedTransport>
