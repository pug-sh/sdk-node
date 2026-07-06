import { createClient } from '@connectrpc/connect'
import { createApiTransport } from './api-transport.js'
import { EventsService } from './gen/sdk/events/v1/events_pb.js'
import { ProfilesSDKService } from './gen/sdk/profiles/v1/profiles_pb.js'
import { ActivityService } from './gen/shared/activity/v1/activity_pb.js'
import { InsightsService } from './gen/shared/insights/v1/insights_pb.js'
import { ProfilesService } from './gen/shared/profiles/v1/profiles_pb.js'

/** One transport shared across the ingestion (sdk.*) and read (shared.*) services. */
export const createRpcClients = (endpoint: string, apiKey: string) => {
  const transport = createApiTransport(endpoint, apiKey)
  return {
    events: createClient(EventsService, transport),
    profilesSdk: createClient(ProfilesSDKService, transport),
    profiles: createClient(ProfilesService, transport),
    activity: createClient(ActivityService, transport),
    insights: createClient(InsightsService, transport),
  }
}

export type RpcClients = ReturnType<typeof createRpcClients>
