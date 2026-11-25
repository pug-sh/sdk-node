import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { PartialSendError, RefusedError, type Sink } from './batch.js'
import { BatchCreateRequestSchema, type Event } from './gen/sdk/events/v1/events_pb.js'
import { BatchIdentifyRequestSchema, type IdentifyRequest } from './gen/sdk/profiles/v1/profiles_pb.js'
import { log } from './logger.js'
import type { RpcClients } from './rpc.js'

const MAX_REFUSED_NAMED = 3

const refused = (
  invalid: readonly { index: number; violations: readonly string[] }[],
  batch: unknown[],
  items: string,
  name: (index: number) => string,
): RefusedError => {
  const named = invalid
    .slice(0, MAX_REFUSED_NAMED)
    .map(({ index, violations }) => `${name(index)}: ${violations.join('; ')}`)
  if (invalid.length > MAX_REFUSED_NAMED) {
    named.push(`and ${invalid.length - MAX_REFUSED_NAMED} more`)
  }
  return new RefusedError(
    invalid.map(({ index }) => batch[index]),
    `Server refused ${invalid.length} of ${batch.length} ${items}: ${named.join(' | ')}`,
  )
}

/** Wraps the EventsService client as the sink the batch transport drains into. */
export const createEventSink = (events: RpcClients['events']): Sink<Event> => ({
  sendBatch: async (batch: Event[]) => {
    const res = await events.batchCreate(create(BatchCreateRequestSchema, { events: batch }))
    // A dropped event isn't an RPC error. The server names only the invalid ones, which go to onError.
    if (res.dropped > res.invalidEvents.length) {
      const reasons = Object.entries(res.droppedByReason).map(([reason, n]) => `${n} ${reason}`)
      log.warn(`Server dropped ${res.dropped} of ${batch.length} event(s): ${reasons.join(', ')}.`)
    }
    if (res.invalidEvents.length > 0) {
      throw refused(res.invalidEvents, batch, 'event(s)', i => `"${batch[i]?.kind}"`)
    }
  },
})

/**
 * Sends queued identifies with BatchIdentify, or with one Identify call each on a server that
 * predates it.
 */
export const createIdentifySink = (profiles: RpcClients['profilesSdk']): Sink<IdentifyRequest> => {
  let unbatched = false
  return {
    sendBatch: async (batch: IdentifyRequest[]) => {
      if (!unbatched) {
        try {
          const { invalidIdentifies } = await profiles.batchIdentify(
            create(BatchIdentifyRequestSchema, { identifies: batch }),
          )
          if (invalidIdentifies.length > 0) {
            throw refused(invalidIdentifies, batch, 'identifies', i => `"${batch[i]?.externalId}"`)
          }
          return
        } catch (err) {
          // An older server answers 404 (Unimplemented), which would otherwise be dropped as
          // permanent. A proxy with no server behind it does too, so the fallback sticks only once
          // an Identify succeeds.
          if (!(err instanceof ConnectError && err.code === Code.Unimplemented)) {
            throw err
          }
        }
      }
      for (const [i, item] of batch.entries()) {
        try {
          await profiles.identify(item)
        } catch (err) {
          throw new PartialSendError(i, err)
        }
        if (!unbatched) {
          unbatched = true
          log.warn('Server has no BatchIdentify; sending identifies one at a time.')
        }
      }
    },
  }
}
