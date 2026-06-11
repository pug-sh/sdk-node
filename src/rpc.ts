import { EventsService } from '@buf/fivebits_pug.bufbuild_es/sdk/events/v1/events_pb.js'
import { ProfilesSDKService } from '@buf/fivebits_pug.bufbuild_es/sdk/profiles/v1/profiles_pb.js'
import { ActivityService } from '@buf/fivebits_pug.bufbuild_es/shared/activity/v1/activity_pb.js'
import { InsightsService } from '@buf/fivebits_pug.bufbuild_es/shared/insights/v1/insights_pb.js'
import { ProfilesService } from '@buf/fivebits_pug.bufbuild_es/shared/profiles/v1/profiles_pb.js'
import { createClient } from '@connectrpc/connect'
import { createApiTransport } from './api-transport.js'

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
