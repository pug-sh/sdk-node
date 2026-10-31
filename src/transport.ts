import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { PartialSendError, type Sink } from './batch.js'
import { BatchCreateRequestSchema, type Event } from './gen/sdk/events/v1/events_pb.js'
import { BatchIdentifyRequestSchema, type IdentifyRequest } from './gen/sdk/profiles/v1/profiles_pb.js'
import { log } from './logger.js'
import type { RpcClients } from './rpc.js'

/** Wraps the EventsService client as the sink the batch transport drains into. */
export const createEventSink = (events: RpcClients['events']): Sink<Event> => ({
  sendBatch: async (batch: Event[]) => {
    const res = await events.batchCreate(create(BatchCreateRequestSchema, { events: batch }))
    // A refused event isn't an RPC error, so this is the only sign it was lost.
    if (res.dropped > 0) {
      log.warn(`Server dropped ${res.dropped} of ${batch.length} event(s):`, res.droppedByReason)
    }
    return res
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
          await profiles.batchIdentify(create(BatchIdentifyRequestSchema, { identifies: batch }))
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
