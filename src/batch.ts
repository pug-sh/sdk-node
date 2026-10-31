import { ConnectError } from '@connectrpc/connect'
import { log } from './logger.js'

export interface BatchConfig {
  readonly maxSize: number
  readonly maxWaitMs: number
  readonly maxQueueSize: number
}

const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxSize: 100,
  maxWaitMs: 5000,
  maxQueueSize: 10_000,
}

/** Hard cap per BatchCreate and BatchIdentify request, enforced by their protos. */
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

export interface Sink<T> {
  sendBatch: (items: T[]) => Promise<unknown>
}

/** Thrown by a sink that delivered the first `sent` items of a batch before failing with `cause`. */
export class PartialSendError extends Error {
  readonly sent: number

  constructor(sent: number, cause: unknown) {
    super(`batch failed after ${sent} item(s) were delivered`, { cause })
    this.name = 'PartialSendError'
    this.sent = sent
  }
}

export interface ItemNames {
  readonly one: string
  readonly many: string
}

export const IDENTIFY_NAMES: ItemNames = { one: 'identify', many: 'identifies' }

const EVENT_NAMES: ItemNames = { one: 'event', many: 'events' }

/** Defaults missing or invalid settings (warning on invalid) and clamps `maxSize` to the request cap. */
export const resolveBatchConfig = (partialConfig?: Partial<BatchConfig>): BatchConfig => {
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

  const maxSize = validated('maxSize', cfg.maxSize, 1, DEFAULT_BATCH_CONFIG.maxSize)
  if (maxSize > MAX_BATCH) {
    log.warn(`batch.maxSize exceeds the ${MAX_BATCH}-item request cap, clamping to ${MAX_BATCH}.`)
  }
  return {
    maxSize: Math.min(MAX_BATCH, maxSize),
    maxWaitMs: validated('maxWaitMs', cfg.maxWaitMs, 0, DEFAULT_BATCH_CONFIG.maxWaitMs),
    maxQueueSize: validated('maxQueueSize', cfg.maxQueueSize, 1, DEFAULT_BATCH_CONFIG.maxQueueSize),
  }
}

/**
 * In-memory batching transport. Items accumulate and flush on a size or interval
 * trigger; transient send failures keep items queued for retry, permanent failures
 * dead-letter via `onError`. `close()` drains and reports anything still undelivered.
 * With `sizeOf`, a request is also cut before its items pass `maxBytes`; a bigger item goes alone.
 */
export const createBatchedTransport = <T>(
  inner: Sink<T>,
  partialConfig?: Partial<BatchConfig>,
  onError: (err: unknown, items: T[]) => void = () => {},
  {
    names = EVENT_NAMES,
    sizeOf,
    maxBytes = Number.POSITIVE_INFINITY,
  }: { names?: ItemNames; sizeOf?: (item: T) => number; maxBytes?: number } = {},
) => {
  const count = (n: number): string => `${n} ${n === 1 ? names.one : names.many}`

  // A throwing onError would abort the drain and silently drop the remaining chunks.
  const safeOnError = (err: unknown, items: T[]): void => {
    try {
      onError(err, items)
    } catch (cbErr) {
      log.error(`onError callback threw; ${count(items.length)} may be lost:`, cbErr)
    }
  }

  const { maxSize, maxWaitMs, maxQueueSize } = resolveBatchConfig(partialConfig)

  let buffer: T[] = []
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
    // Unref so a pending flush timer never keeps the Node process alive on its own; close() and
    // flush() still drain explicitly. (Optional-chained: a no-op where unref is unavailable.)
    timer.unref?.()
  }

  const chunkEnd = (batch: T[], start: number): number => {
    let end = start
    let bytes = 0
    while (end < batch.length && end - start < maxSize) {
      const size = sizeOf?.(batch[end]) ?? 0
      if (end > start && bytes + size > maxBytes) {
        break
      }
      bytes += size
      end++
    }
    return end
  }

  const sendChunk = async (chunk: T[]): Promise<{ err: unknown; unsent: T[] } | null> => {
    try {
      await inner.sendBatch(chunk)
      return null
    } catch (thrown) {
      let err = thrown
      let unsent = chunk
      if (thrown instanceof PartialSendError) {
        err = thrown.cause
        unsent = chunk.slice(thrown.sent)
      }
      if (isPermanentError(err)) {
        log.error(`Permanent error, ${count(unsent.length)} dropped (will NOT retry):`, err)
        safeOnError(err, unsent)
        return null
      }
      return { err, unsent }
    }
  }

  // Drains are serialized so a retry goes out ahead of anything queued after it.
  let queued: Promise<void> | null = null
  // Set while a retry waits out maxWaitMs, so new items reaching maxSize don't cut the wait short.
  let retrying = false

  const drain = async (): Promise<void> => {
    queued = null
    const batch = buffer.splice(0, buffer.length)
    let start = 0
    while (start < batch.length) {
      const end = chunkEnd(batch, start)
      const failed = await sendChunk(batch.slice(start, end))
      start = end
      if (!failed) {
        continue
      }
      // Later chunks wait too: sent now, they would land ahead of the retry.
      const unsent = failed.unsent.concat(batch.slice(end))
      if (closed) {
        log.error(`Client closed, ${count(unsent.length)} dropped after transient error:`, failed.err)
        safeOnError(failed.err, unsent)
        return
      }
      log.warn(`Transient error sending ${count(failed.unsent.length)}, will retry:`, failed.err)
      // concat, not unshift(...): spreading a large backlog into a call throws a RangeError.
      buffer = unsent.concat(buffer)
      const overflow = buffer.length - maxQueueSize
      if (overflow > 0) {
        log.warn(`Queue full, dropping oldest ${count(overflow)}`)
        safeOnError(new Error(`queue overflow: dropped oldest ${count(overflow)}`), buffer.splice(0, overflow))
      }
      retrying = true
      clearTimer()
      scheduleFlush()
      return
    }
    retrying = false
  }

  const flush = (): Promise<void> => {
    clearTimer()
    queued ??= inflight.then(drain, drain)
    inflight = queued
    return queued
  }

  return {
    send: (item: T): void => {
      if (closed) {
        safeOnError(new Error('client is closed'), [item])
        return
      }
      if (buffer.length >= maxQueueSize) {
        const dropped = buffer.shift()
        if (dropped) {
          log.warn(`Queue full, dropping oldest ${names.one}`)
          safeOnError(new Error(`queue overflow: dropped oldest ${names.one}`), [dropped])
        }
      }
      buffer.push(item)
      if (buffer.length >= maxSize && !retrying) {
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
      if (buffer.length > 0) {
        const undelivered = buffer.splice(0, buffer.length)
        safeOnError(new Error(`client closed with ${count(undelivered.length)} undelivered`), undelivered)
      }
    },
  }
}

export type BatchedTransport<T> = ReturnType<typeof createBatchedTransport<T>>
