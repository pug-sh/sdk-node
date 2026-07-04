import { BatchCreateRequestSchema, type Event } from '@buf/pugsh_pug.bufbuild_es/sdk/events/v1/events_pb.js'
import { create } from '@bufbuild/protobuf'
import type { EventSink } from './batch.js'
import type { RpcClients } from './rpc.js'

/** Wraps the EventsService client as the sink the batch transport drains into. */
export const createEventSink = (events: RpcClients['events']): EventSink => ({
  sendBatch: (batch: Event[]) => events.batchCreate(create(BatchCreateRequestSchema, { events: batch })),
})
