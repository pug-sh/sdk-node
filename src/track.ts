import { create, type DescMessage, type MessageInitShape, type MessageShape, ScalarType } from '@bufbuild/protobuf'
import { reflect, type ScalarValue } from '@bufbuild/protobuf/reflect'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { createValidator } from '@bufbuild/protovalidate'
import { uuidv7 } from 'uuidv7'
import { type PropertyValue, PropertyValueSchema } from './gen/common/v1/property_value_pb.js'
import { type Event, EventSchema } from './gen/sdk/events/v1/events_pb.js'
import { log } from './logger.js'
import { SDK_VERSION } from './version.js'
import {
  type EventLocation,
  type JsonValue,
  type TrackOptions,
  type WellKnownEventName,
  wellKnownSchemas,
} from './well-known-events.js'

export type {
  EventLocation,
  JsonValue,
  TrackFn,
  TrackOptions,
  WellKnownEventName,
  WellKnownEventPropsMap,
} from './well-known-events.js'

const validator = createValidator()

const isWellKnownEvent = (kind: string): kind is WellKnownEventName => kind in wellKnownSchemas

/** Renders a protovalidate failure result as a single human-readable string for logging. */
export const formatValidationError = (result: ReturnType<typeof validator.validate>): string =>
  result.kind === 'invalid'
    ? result.violations.map(v => `${v.field}: ${v.message}`).join(', ')
    : result.kind === 'error'
      ? String(result.error)
      : ''

// proto's `string.max_len` limits to 1024 *code points*; we cap at 1024 *bytes* instead.
// A UTF-8 byte count is always >= the code-point count, so a 1024-byte cap yields <= 1024
// code points — strictly more conservative than the proto limit, never looser.
const MAX_STRING_BYTES = 1024
const utf8ByteLength = (s: string): number => new TextEncoder().encode(s).byteLength

const truncateToBytes = (s: string, max: number): string => {
  const bytes = new TextEncoder().encode(s)
  if (bytes.byteLength <= max) {
    return s
  }
  let cut = max
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) {
    cut--
  }
  return new TextDecoder().decode(bytes.subarray(0, cut))
}

const makeStringValue = (raw: string): PropertyValue => {
  let value = raw
  if (raw.length * 3 > MAX_STRING_BYTES && utf8ByteLength(raw) > MAX_STRING_BYTES) {
    log.warn(`Property string exceeds ${MAX_STRING_BYTES} bytes, truncating`)
    value = truncateToBytes(raw, MAX_STRING_BYTES)
  }
  return create(PropertyValueSchema, { value: { case: 'stringValue', value } })
}

/**
 * Maps an untyped JS value to a PropertyValue oneof. Returns null when the value cannot
 * be represented; the caller omits the property.
 *   string → stringValue (truncated) · boolean → boolValue · number → int/double
 *   bigint → intValue · Date → timestampValue · object/array → JSON string · null/undefined → drop
 */
const jsValueToPropertyValue = (v: unknown): PropertyValue | null => {
  if (v === null || v === undefined) {
    return null
  }
  if (typeof v === 'string') {
    return makeStringValue(v)
  }
  if (typeof v === 'boolean') {
    return create(PropertyValueSchema, { value: { case: 'boolValue', value: v } })
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      return null
    }
    if (Number.isSafeInteger(v)) {
      return create(PropertyValueSchema, { value: { case: 'intValue', value: BigInt(v) } })
    }
    return create(PropertyValueSchema, { value: { case: 'doubleValue', value: v } })
  }
  if (typeof v === 'bigint') {
    return create(PropertyValueSchema, { value: { case: 'intValue', value: v } })
  }
  if (v instanceof Date) {
    const ms = v.getTime()
    if (!Number.isFinite(ms)) {
      return null
    }
    return create(PropertyValueSchema, { value: { case: 'timestampValue', value: timestampFromMs(ms) } })
  }
  if (typeof v === 'object') {
    let json: string
    try {
      json = JSON.stringify(v)
    } catch (err) {
      // Circular reference, nested bigint, throwing toJSON, etc. The caller logs a generic
      // "not representable" warning; surface the specific cause here so it isn't lost.
      log.warn('Property value is not JSON-serializable, dropping:', err)
      return null
    }
    if (json === undefined) {
      return null
    }
    return makeStringValue(json)
  }
  return null
}

/**
 * Builds a PropertyValue for a known scalar field, picking the oneof case from the field's
 * proto scalar type rather than the JS value (preserves int-vs-double). Returns null for
 * BYTES / unenumerated scalars / type mismatch.
 */
const scalarToPropertyValue = (v: ScalarValue, scalar: ScalarType): PropertyValue | null => {
  switch (scalar) {
    case ScalarType.STRING:
      return typeof v === 'string' ? makeStringValue(v) : null
    case ScalarType.BOOL:
      return typeof v === 'boolean' ? create(PropertyValueSchema, { value: { case: 'boolValue', value: v } }) : null
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return typeof v === 'number' ? create(PropertyValueSchema, { value: { case: 'doubleValue', value: v } }) : null
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
    case ScalarType.FIXED32:
      return typeof v === 'number' && Number.isSafeInteger(v)
        ? create(PropertyValueSchema, { value: { case: 'intValue', value: BigInt(v) } })
        : null
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.FIXED64:
      return typeof v === 'bigint' ? create(PropertyValueSchema, { value: { case: 'intValue', value: v } }) : null
    default:
      return null
  }
}

type WellKnownValidation<Desc extends DescMessage> =
  | { ok: true; msg: MessageShape<Desc>; extras: Record<string, JsonValue> }
  | { ok: false }

/** Validates a well-known event's properties against its proto schema (split into known fields + extras). */
const validateWellKnownProps = <Desc extends DescMessage>(
  schema: Desc,
  kind: string,
  data: Record<string, unknown>,
): WellKnownValidation<Desc> => {
  const knownNames = new Set(schema.fields.map(f => f.localName))
  const knownData: Record<string, unknown> = {}
  const extras: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(data)) {
    if (knownNames.has(k)) {
      knownData[k] = v
    } else if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
      log.warn(`Extra property "${k}" on event "${kind}" has non-serializable type ${typeof v}, skipping`)
    } else {
      extras[k] = v as JsonValue
    }
  }

  let msg: MessageShape<Desc>
  try {
    msg = create(schema, knownData as MessageInitShape<Desc>)
  } catch (err) {
    log.error(`Event "${kind}" dropped: invalid properties for "${schema.typeName}":`, err)
    return { ok: false }
  }

  const result = validator.validate(schema, msg)
  if (result.kind !== 'valid') {
    log.error(
      `Event "${kind}" dropped: properties validation failed for "${schema.typeName}":`,
      formatValidationError(result),
    )
    return { ok: false }
  }

  return { ok: true, msg, extras }
}

/** Walks a typed well-known message and builds customProperties from its set scalar fields. */
const buildKnownPropertyMap = <Desc extends DescMessage>(
  schema: Desc,
  msg: MessageShape<Desc>,
): Record<string, PropertyValue> => {
  const out: Record<string, PropertyValue> = {}
  const r = reflect(schema, msg, false)
  for (const field of schema.fields) {
    if (field.fieldKind !== 'scalar') {
      log.warn(`Field "${schema.typeName}.${field.localName}" has unsupported fieldKind "${field.fieldKind}", skipping`)
      continue
    }
    if (!r.isSet(field)) {
      continue
    }
    const pv = scalarToPropertyValue(r.get(field), field.scalar)
    if (pv) {
      out[field.localName] = pv
    } else {
      log.warn(
        `Field "${schema.typeName}.${field.localName}" has unsupported scalar type ${ScalarType[field.scalar]}, skipping`,
      )
    }
  }
  return out
}

const mapPropsViaHeuristic = (
  source: Record<string, unknown>,
  customProperties: Record<string, PropertyValue>,
  kind: string,
): void => {
  for (const [k, v] of Object.entries(source)) {
    const pv = jsValueToPropertyValue(v)
    if (pv) {
      customProperties[k] = pv
    } else if (v !== null && v !== undefined) {
      log.warn(`Property "${k}" on event "${kind}" not representable (${typeof v}), skipping`)
    }
  }
}

// Proto Timestamp tops out at year 9999; a value past it (or negative/fractional) is almost
// certainly a unit mistake — seconds or microseconds passed where epoch milliseconds are expected.
const MAX_OCCUR_TIME_MS = 253_402_300_799_000

/** `0` (the Unix epoch) is a real timestamp; anything out of range falls back rather than throwing. */
const resolveOccurTime = (timestamp?: number) => {
  if (timestamp === undefined) {
    return timestampNow()
  }
  if (Number.isInteger(timestamp) && timestamp >= 0 && timestamp <= MAX_OCCUR_TIME_MS) {
    return timestampFromMs(timestamp)
  }
  log.warn(`Ignoring invalid track timestamp ${timestamp}; expected epoch milliseconds. Using current time.`)
  return timestampNow()
}

type LocationFieldType<T> = NonNullable<T> extends number ? 'number' : NonNullable<T> extends string ? 'string' : never

const LOCATION_FIELDS: { readonly [K in keyof EventLocation]-?: LocationFieldType<EventLocation[K]> } = {
  continent: 'string',
  country: 'string',
  region: 'string',
  city: 'string',
  postalCode: 'string',
  metroCode: 'string',
  timezone: 'string',
  latitude: 'number',
  longitude: 'number',
}

const LOCATION_FIELD_NAMES = Object.keys(LOCATION_FIELDS).join(', ')

// Mirrors internal/geo/countries.go. The server stores $country unvalidated and only the
// choropleth filters it, so a bad code is aggregated into a permanent rollup dimension and
// then simply missing from the map. "XX" — Cloudflare's unknown — passes a two-letter check.
const COUNTRY_CODES = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ ' +
    'BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR ' +
    'CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ' +
    'ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ ' +
    'LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ ' +
    'MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF ' +
    'PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI ' +
    'SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR ' +
    'TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
  ).split(' '),
)

// jsValueToPropertyValue files a whole number as an int, a different Variant slot from the
// Float64 one every other writer of $latitude/$longitude uses.
const makeDoubleValue = (value: number): PropertyValue =>
  create(PropertyValueSchema, { value: { case: 'doubleValue', value } })

/**
 * Renders TrackOptions.location as geo auto-properties. The server skips geo enrichment on
 * private-key requests, which is all this SDK makes, so these keys are the only geo the event
 * will ever carry — a dropped field is a permanent hole, not one filled in later.
 */
const locationProps = (location: EventLocation | undefined, kind: string): Record<string, PropertyValue> => {
  const props: Record<string, PropertyValue> = {}
  if (location === undefined || location === null) {
    return props
  }
  if (typeof location !== 'object' || Array.isArray(location)) {
    const got = Array.isArray(location) ? 'array' : typeof location
    log.warn(`Ignoring location on event "${kind}": expected an object, got ${got}`)
    return props
  }

  for (const key of Object.keys(location)) {
    if (!Object.hasOwn(LOCATION_FIELDS, key)) {
      log.warn(`Ignoring unknown location field "${key}" on event "${kind}"; expected one of ${LOCATION_FIELD_NAMES}`)
    }
  }

  const coords: { latitude?: number; longitude?: number } = {}
  for (const [field, expected] of Object.entries(LOCATION_FIELDS) as [keyof EventLocation, 'string' | 'number'][]) {
    const value = location[field]
    if (value === undefined || value === null) {
      continue
    }
    if (typeof value !== expected) {
      log.warn(`Ignoring location.${field} on event "${kind}": expected a ${expected}, got ${typeof value}`)
      continue
    }
    if (typeof value === 'number') {
      const limit = field === 'latitude' ? 90 : 180
      if (!Number.isFinite(value) || Math.abs(value) > limit) {
        log.warn(`Ignoring location.${field} ${value} on event "${kind}"; expected a number within ±${limit}`)
        continue
      }
      coords[field as 'latitude' | 'longitude'] = value
      continue
    }
    const trimmed = value.trim()
    if (trimmed === '') {
      continue
    }
    if (field === 'country') {
      const code = trimmed.toUpperCase()
      if (!COUNTRY_CODES.has(code)) {
        log.warn(
          `Ignoring location.country "${value}" on event "${kind}"; expected an ISO 3166-1 alpha-2 code like "DE"`,
        )
        continue
      }
      props.$country = makeStringValue(code)
      continue
    }
    props[`$${field}`] = makeStringValue(trimmed)
  }

  // A lone coordinate reads as a real position with the other axis at 0, so send both or neither.
  if (coords.latitude !== undefined && coords.longitude !== undefined) {
    props.$latitude = makeDoubleValue(coords.latitude)
    props.$longitude = makeDoubleValue(coords.longitude)
  } else if (coords.latitude !== undefined || coords.longitude !== undefined) {
    log.warn(`Ignoring location coordinates on event "${kind}": latitude and longitude must be set together`)
  }

  if (Object.keys(props).length === 0) {
    log.warn(`Ignoring location on event "${kind}": no usable fields; the event will carry no geo`)
  }
  return props
}

/**
 * Builds and validates an Event for ingestion. Returns null (and logs) on any validation
 * failure so the caller can drop the event without throwing.
 */
export const toEvent = (
  kind: string,
  sessionId: string,
  distinctId: string,
  props?: Record<string, unknown>,
  opts?: TrackOptions,
): Event | null => {
  let customProperties: Record<string, PropertyValue> = {}

  if (isWellKnownEvent(kind)) {
    const schema = wellKnownSchemas[kind]
    const validated = validateWellKnownProps(schema, kind, props ?? {})
    if (!validated.ok) {
      return null
    }
    customProperties = buildKnownPropertyMap(schema, validated.msg)
    mapPropsViaHeuristic(validated.extras, customProperties, kind)
  } else if (props) {
    mapPropsViaHeuristic(props, customProperties, kind)
  }

  let event: Event
  try {
    event = create(EventSchema, {
      eventId: uuidv7(),
      autoProperties: {
        $lib: makeStringValue('pug-node'),
        $sdkVersion: makeStringValue(SDK_VERSION),
        $platform: makeStringValue('server'),
        ...locationProps(opts?.location, kind),
      },
      customProperties,
      kind,
      sessionId,
      distinctId,
      occurTime: resolveOccurTime(opts?.timestamp),
    })
  } catch (err) {
    log.error(`Event "${kind}" dropped: failed to create Event proto:`, err)
    return null
  }

  const result = validator.validate(EventSchema, event)
  if (result.kind !== 'valid') {
    const source = isWellKnownEvent(kind) ? 'well-known' : 'custom'
    log.error(`Event "${kind}" (${source}) failed Event-level validation:`, formatValidationError(result))
    return null
  }

  return event
}
