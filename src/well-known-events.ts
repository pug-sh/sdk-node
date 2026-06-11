import type { JsonValue, MessageInitShape } from '@bufbuild/protobuf'
import { wellKnownSchemas } from './well-known-events.generated.js'

/**
 * Options passed to `track()`. `timestamp` overrides the default current time (epoch
 * milliseconds); `sessionId` overrides the client's default per-instance session id.
 */
export interface TrackOptions {
  readonly timestamp?: number
  readonly sessionId?: string
}

export type { JsonValue }
export { wellKnownSchemas }

type WellKnownSchemas = typeof wellKnownSchemas
export type WellKnownEventName = keyof WellKnownSchemas
export type WellKnownEventPropsMap = { [K in WellKnownEventName]: MessageInitShape<WellKnownSchemas[K]> }

/**
 * Overloaded track signature. The first overload narrows `props` for well-known events;
 * the second accepts any string kind with loose props. `distinctId` (who the event is
 * for) is required first — a server SDK has no ambient user. Runtime validation in
 * track.ts is the real safety net if the typed overload is bypassed.
 */
export type TrackFn = {
  <K extends WellKnownEventName>(
    distinctId: string,
    event: K,
    props?: WellKnownEventPropsMap[K] & Record<string, JsonValue>,
    options?: TrackOptions,
  ): void
  (distinctId: string, event: string, props?: Record<string, JsonValue>, options?: TrackOptions): void
}
