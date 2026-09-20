import type { JsonValue, MessageInitShape } from '@bufbuild/protobuf'
import { wellKnownSchemas } from './well-known-events.generated.js'

/**
 * Where the visitor is, for an event your backend sends on their behalf.
 *
 * Pug only derives geo from CDN headers on browser (public-key) requests. This SDK uses a
 * private key, so the server adds no geo of its own: an event carries what you set here, or
 * none at all. An unusable field is dropped with a warning; the rest is still sent.
 */
export interface EventLocation {
  readonly continent?: string
  /** ISO 3166-1 alpha-2, e.g. `DE`. Case and surrounding spaces are normalized. */
  readonly country?: string
  readonly region?: string
  readonly city?: string
  readonly postalCode?: string
  readonly metroCode?: string
  /** IANA name, e.g. `Europe/Berlin`. */
  readonly timezone?: string
  /** Decimal degrees; only sent when paired with `longitude`. */
  readonly latitude?: number
  /** Decimal degrees; only sent when paired with `latitude`. */
  readonly longitude?: number
}

/**
 * Options passed to `track()`. `timestamp` overrides the default current time (epoch
 * milliseconds); `sessionId` overrides the client's default per-instance session id;
 * `location` records the visitor's location, which a server SDK's requests cannot reveal.
 */
export interface TrackOptions {
  readonly timestamp?: number
  readonly sessionId?: string
  readonly location?: EventLocation
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
