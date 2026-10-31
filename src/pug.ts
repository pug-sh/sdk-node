import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { createValidator } from '@bufbuild/protovalidate'
import { uuidv7 } from 'uuidv7'
import {
  type BatchConfig,
  type BatchedTransport,
  createBatchedTransport,
  IDENTIFY_NAMES,
  resolveBatchConfig,
} from './batch.js'
import { toPugError } from './errors.js'
import { type Event, EventSchema } from './gen/sdk/events/v1/events_pb.js'
import { type IdentifyRequest, IdentifyRequestSchema } from './gen/sdk/profiles/v1/profiles_pb.js'
import { log } from './logger.js'
import { createRpcClients, type RpcClients } from './rpc.js'
import { formatValidationError, type JsonValue, type TrackFn, type TrackOptions, toEvent } from './track.js'
import { createEventSink, createIdentifySink } from './transport.js'
import { DEFAULT_ENDPOINT, isPlainObject } from './utils.js'

export interface Options {
  /** Project API key. Server SDKs use a private key (`prv_…`). */
  readonly apiKey: string
  /** Pug server origin. Defaults to the hosted endpoint. */
  readonly endpoint?: string
  /** Batching overrides; events and identifies each get a queue with these settings. */
  readonly batch?: Partial<BatchConfig>
  /**
   * Dead-letter / diagnostics hook for queued events and identifies that could not be delivered
   * (permanent send failure, queue overflow, or still-undelivered at `close()`).
   */
  readonly onError?: OnError
}

/** What one failure lost. Either list may be empty. */
export interface Undelivered {
  readonly events: Event[]
  readonly identifies: IdentifyRequest[]
}

export type OnError = (err: unknown, lost: Undelivered) => void

export interface IdentifyOptions {
  /** SDK anonymous id (must start with "anon-"). Triggers anon→identified merge. */
  readonly anonymousId?: string
  readonly deviceId?: string
}

const validator = createValidator()

// NATS refuses a message over 1 MiB and an item can't be split, so an oversized one would fail
// every send. The margin is for what the server adds.
const MAX_ITEM_BYTES = 900 << 10

// An oversized request gets a transient code and would retry forever. BatchCreate is published as
// one NATS message; BatchIdentify is split, so it only has to fit the 8 MiB request limit.
const MAX_EVENT_BATCH_BYTES = 512 << 10
const MAX_IDENTIFY_BATCH_BYTES = 4 << 20

const eventSize = (event: Event): number => toBinary(EventSchema, event).byteLength

const identifySize = (req: IdentifyRequest): number => toBinary(IdentifyRequestSchema, req).byteLength

const hasNonFinite = (value: JsonValue): boolean =>
  typeof value === 'number'
    ? !Number.isFinite(value)
    : typeof value === 'object' && value !== null && Object.values(value).some(hasNonFinite)

export class Pug {
  private readonly rpc: RpcClients
  private readonly eventQueue: BatchedTransport<Event>
  private readonly identifyQueue: BatchedTransport<IdentifyRequest>
  private readonly sessionId = uuidv7()
  private closed = false

  constructor(options: Options) {
    if (!options.apiKey || typeof options.apiKey !== 'string') {
      throw new Error('[Pug SDK] apiKey is required and must be a non-empty string')
    }
    if (!options.apiKey.startsWith('prv_')) {
      throw new Error('[Pug SDK] apiKey must be a private key (prv_…) for the server SDK')
    }
    const endpoint = options.endpoint || DEFAULT_ENDPOINT

    this.rpc = createRpcClients(endpoint, options.apiKey)
    // Resolved once, so an invalid setting warns once rather than once per queue.
    const batch = resolveBatchConfig(options.batch)
    const onError = options.onError
    this.eventQueue = createBatchedTransport(
      createEventSink(this.rpc.events),
      batch,
      (err, events) => onError?.(err, { events, identifies: [] }),
      { sizeOf: eventSize, maxBytes: MAX_EVENT_BATCH_BYTES },
    )
    this.identifyQueue = createBatchedTransport(
      createIdentifySink(this.rpc.profilesSdk),
      batch,
      (err, identifies) => onError?.(err, { events: [], identifies }),
      { names: IDENTIFY_NAMES, sizeOf: identifySize, maxBytes: MAX_IDENTIFY_BATCH_BYTES },
    )
  }

  // --- ingestion (never throws) --------------------------------------------

  /**
   * Enqueue an event for `distinctId`. Non-blocking and throw-free: invalid input and a
   * closed client are logged and dropped, never thrown.
   */
  track: TrackFn = (distinctId: string, kind: string, props?: Record<string, JsonValue>, opts?: TrackOptions): void => {
    try {
      if (this.closed) {
        log.warn('track() called after close().')
        return
      }
      if (!distinctId || typeof distinctId !== 'string') {
        log.error('track() requires a non-empty distinctId string.')
        return
      }
      // The server rejects a whole batch over one such id, taking other users' events with it.
      if (distinctId.startsWith('cookieless-')) {
        log.error("track() distinctId must not start with the reserved 'cookieless-' prefix.")
        return
      }
      const event = toEvent(kind, opts?.sessionId ?? this.sessionId, distinctId, props, opts)
      if (!event) {
        return // toEvent already logged the reason
      }
      const size = eventSize(event)
      if (size > MAX_ITEM_BYTES) {
        log.error(`track("${kind}") dropped: ${size} bytes exceeds the ${MAX_ITEM_BYTES}-byte limit.`)
        return
      }
      this.eventQueue.send(event)
    } catch (err) {
      log.error(`Unexpected error in track("${kind}"):`, err)
    }
  }

  /**
   * Queue a create-or-update of the profile for `externalId`; traits are shallow-merged into the
   * stored ones. Non-blocking and throw-free like `track()`: identifies are sent in batches, and
   * invalid input is logged and dropped.
   */
  identify(externalId: string, traits?: Record<string, JsonValue>, opts?: IdentifyOptions): void {
    try {
      if (this.closed) {
        log.warn('identify() called after close().')
        return
      }
      if (!externalId || typeof externalId !== 'string') {
        log.error('identify() requires a non-empty externalId string.')
        return
      }
      if (traits != null && !isPlainObject(traits)) {
        log.error('identify() traits must be a plain object.')
        return
      }

      const req = create(IdentifyRequestSchema, {
        externalId,
        traits,
        ...(opts?.anonymousId && { anonymousId: opts.anonymousId }),
        ...(opts?.deviceId && { deviceId: opts.deviceId }),
      })

      const validation = validator.validate(IdentifyRequestSchema, req)
      if (validation.kind !== 'valid') {
        log.error(`Invalid identify request: ${formatValidationError(validation)}`)
        return
      }

      const bytes = toBinary(IdentifyRequestSchema, req)
      if (bytes.byteLength > MAX_ITEM_BYTES) {
        log.error(`identify() dropped: ${bytes.byteLength} bytes exceeds the ${MAX_ITEM_BYTES}-byte limit.`)
        return
      }
      // A copy, so a later change to the caller's traits can't alter what is sent.
      const queued = fromBinary(IdentifyRequestSchema, bytes)
      // The server would store NaN or Infinity as strings.
      const queuedTraits = queued.traits ?? {}
      for (const [key, value] of Object.entries(queuedTraits)) {
        if (hasNonFinite(value)) {
          log.warn(`Trait "${key}" not representable (NaN or Infinity), skipping`)
          delete queuedTraits[key]
        }
      }
      this.identifyQueue.send(queued)
    } catch (err) {
      log.error(`Failed to identify "${externalId}":`, err)
    }
  }

  /**
   * Send the currently-queued events and identifies now. Resolves when those attempts settle,
   * not a guarantee the queues are empty, since a transient failure re-queues for a later
   * flush. Use `close()` to drain fully on shutdown.
   */
  async flush(): Promise<void> {
    await Promise.all([this.eventQueue.flush(), this.identifyQueue.flush()])
  }

  /**
   * Drain and shut down; call on graceful exit. Queued events and identifies are flushed, and anything
   * still undeliverable is reported via `onError` (not retried). Later track/identify calls warn + drop.
   */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([this.eventQueue.close(), this.identifyQueue.close()])
  }

  // --- reads (private key; throw PugError) ---------------------------------

  readonly profiles = {
    get: (id: string, opts?: { includeBots?: boolean }) =>
      this.read(() => this.rpc.profiles.get({ id, ...opts }).then(r => r.profile)),
    getByExternalId: (externalId: string, opts?: { includeBots?: boolean }) =>
      this.read(() => this.rpc.profiles.getByExternalId({ externalId, ...opts }).then(r => r.profile)),
    delete: (id: string) => this.read(() => this.rpc.profiles.delete({ id }).then(() => undefined)),
    /** Auto-paginating async iterator over matching profiles. */
    list: (req: Parameters<RpcClients['profiles']['list']>[0] = {}) => this.listProfiles(req),
  }

  readonly activity = {
    feed: (req: Parameters<RpcClients['activity']['getActivityFeed']>[0]) =>
      this.read(() => this.rpc.activity.getActivityFeed(req)),
    eventExplorer: (req: Parameters<RpcClients['activity']['getEventExplorer']>[0]) =>
      this.read(() => this.rpc.activity.getEventExplorer(req)),
    heatmap: (req: Parameters<RpcClients['activity']['getActivityHeatmap']>[0]) =>
      this.read(() => this.rpc.activity.getActivityHeatmap(req)),
    profileSessions: (req: Parameters<RpcClients['activity']['getProfileSessions']>[0]) =>
      this.read(() => this.rpc.activity.getProfileSessions(req)),
    profileStats: (req: Parameters<RpcClients['activity']['getProfileStats']>[0]) =>
      this.read(() => this.rpc.activity.getProfileStats(req)),
    filterSchema: () => this.read(() => this.rpc.activity.getFilterSchema({})),
    propertyValues: (req: Parameters<RpcClients['activity']['getPropertyValues']>[0]) =>
      this.read(() => this.rpc.activity.getPropertyValues(req)),
  }

  readonly insights = {
    query: (req: Parameters<RpcClients['insights']['query']>[0]) => this.read(() => this.rpc.insights.query(req)),
    segmentUsers: (req: Parameters<RpcClients['insights']['segmentUsers']>[0]) =>
      this.read(() => this.rpc.insights.segmentUsers(req)),
    filterSchema: () => this.read(() => this.rpc.insights.getFilterSchema({})),
    propertyValues: (req: Parameters<RpcClients['insights']['getPropertyValues']>[0]) =>
      this.read(() => this.rpc.insights.getPropertyValues(req)),
  }

  private async *listProfiles(req: Parameters<RpcClients['profiles']['list']>[0]) {
    // Normalize stream errors to PugError too, so `list` honors the same read contract as the
    // unary reads (which go through `read()`); a mid-pagination failure must not escape as a
    // raw ConnectError the caller's `instanceof PugError` handler would miss.
    try {
      for await (const page of this.rpc.profiles.list(req)) {
        yield* page.profiles
      }
    } catch (err) {
      throw toPugError(err)
    }
  }

  /** Reads are NOT auto-retried; the caller owns timeout/retry. Errors normalize to PugError. */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      throw toPugError(err)
    }
  }
}
