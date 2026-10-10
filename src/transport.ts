import { create } from '@bufbuild/protobuf'
import type { EventSink } from './batch.js'
import { BatchCreateRequestSchema, type Event } from './gen/sdk/events/v1/events_pb.js'
import { log } from './logger.js'
import type { RpcClients } from './rpc.js'

/** Wraps the EventsService client as the sink the batch transport drains into. */
export const createEventSink = (events: RpcClients['events']): EventSink => ({
  sendBatch: async (batch: Event[]) => {
    const res = await events.batchCreate(create(BatchCreateRequestSchema, { events: batch }))
    // A refused event isn't an RPC error, so this is the only sign it was lost.
    if (res.dropped > 0) {
      log.warn(`Server dropped ${res.dropped} of ${batch.length} event(s):`, res.droppedByReason)
    }
    return res
  },
})
