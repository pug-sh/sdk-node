import { IdentifyRequestSchema } from '@buf/fivebits_pug.bufbuild_es/sdk/profiles/v1/profiles_pb.js'
import { create } from '@bufbuild/protobuf'
import { createValidator } from '@bufbuild/protovalidate'
import { uuidv7 } from 'uuidv7'
import { type BatchConfig, type BatchedTransport, createBatchedTransport, type OnError } from './batch.js'
import { toPugError } from './errors.js'
import { log } from './logger.js'
import { createRpcClients, type RpcClients } from './rpc.js'
import { formatValidationError, type JsonValue, type TrackFn, type TrackOptions, toEvent } from './track.js'
import { createEventSink } from './transport.js'
import { DEFAULT_ENDPOINT } from './utils.js'

export interface Options {
  /** Project API key. Server SDKs use a private key (`prv_…`). */
  readonly apiKey: string
  /** Pug server origin. Defaults to the hosted endpoint. */
  readonly baseUrl?: string
  /** Batching overrides for the ingestion buffer. */
  readonly batch?: Partial<BatchConfig>
  /**
   * Dead-letter / diagnostics hook for buffered `track()` events that could not be delivered
   * (permanent send failure, queue overflow, or still-undelivered at `close()`). `identify()`
   * failures are logged, not routed here.
   */
  readonly onError?: OnError
}

export interface IdentifyOptions {
  /** SDK anonymous id (must start with "anon-"). Triggers anon→identified merge. */
  readonly anonymousId?: string
  readonly deviceId?: string
}

const validator = createValidator()

export class Pug {
  private readonly rpc: RpcClients
  private readonly transport: BatchedTransport
  private readonly sessionId = uuidv7()
  private closed = false

  constructor(options: Options) {
    if (!options.apiKey || typeof options.apiKey !== 'string') {
      throw new Error('[Pug SDK] apiKey is required and must be a non-empty string')
    }
    if (!options.apiKey.startsWith('prv_')) {
      throw new Error('[Pug SDK] apiKey must be a private key (prv_…) for the server SDK')
    }
    const baseUrl = options.baseUrl || DEFAULT_ENDPOINT

    this.rpc = createRpcClients(baseUrl, options.apiKey)
    this.transport = createBatchedTransport(createEventSink(this.rpc.events), options.batch, options.onError)
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
      const event = toEvent(kind, opts?.sessionId ?? this.sessionId, distinctId, props, opts)
      if (!event) {
        return // toEvent already logged the reason
      }
      this.transport.send(event)
    } catch (err) {
      log.error(`Unexpected error in track("${kind}"):`, err)
    }
  }

  /** Create or update a profile. Never throws — failures are logged. */
  async identify(externalId: string, traits?: Record<string, JsonValue>, opts?: IdentifyOptions): Promise<void> {
    try {
      if (this.closed) {
        log.warn('identify() called after close().')
        return
      }
      if (!externalId || typeof externalId !== 'string') {
        log.error('identify() requires a non-empty externalId string.')
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

      await this.rpc.profilesSdk.identify(req)
    } catch (err) {
      log.error(`Failed to identify "${externalId}":`, err)
    }
  }

  /**
   * Send the currently-buffered events now. Resolves when that batch attempt settles —
   * not a guarantee the queue is empty, since a transient failure re-queues for a later
   * flush. Use `close()` to drain fully on shutdown.
   */
  flush(): Promise<void> {
    return this.transport.flush()
  }

  /**
   * Drain and shut down; call on graceful exit. Buffered events are flushed, and anything still
   * undeliverable is reported via `onError` (not retried). Later track/identify calls warn + drop.
   */
  close(): Promise<void> {
    this.closed = true
    return this.transport.close()
  }

  // --- reads (private key; throw PugError) ---------------------------------

  readonly profiles = {
    get: (id: string) => this.read(() => this.rpc.profiles.get({ id }).then(r => r.profile)),
    getByExternalId: (externalId: string) =>
      this.read(() => this.rpc.profiles.getByExternalId({ externalId }).then(r => r.profile)),
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

  /** Reads are NOT auto-retried — the caller owns timeout/retry. Errors normalize to PugError. */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      throw toPugError(err)
    }
  }
}
