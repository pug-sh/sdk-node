import { uuidv7 } from 'uuidv7'
import { describe, expect, it, vi } from 'vitest'
import { type EventLocation, toEvent } from './track.js'
import { wellKnownSchemas } from './well-known-events.js'

const SESSION = uuidv7()

describe('toEvent (custom events)', () => {
  it('maps property types into the customProperties oneof', () => {
    const e = toEvent('my.custom', SESSION, 'user_1', {
      amount: 5,
      ratio: 1.5,
      ok: true,
      name: 'hello',
      when: new Date(0),
    })
    expect(e).not.toBeNull()
    const cp = e?.customProperties
    expect(cp?.amount.value.case).toBe('intValue')
    expect(cp?.ratio.value.case).toBe('doubleValue')
    expect(cp?.ok.value.case).toBe('boolValue')
    expect(cp?.name.value.case).toBe('stringValue')
    expect(cp?.when.value.case).toBe('timestampValue')
    expect(e?.kind).toBe('my.custom')
    expect(e?.distinctId).toBe('user_1')
  })

  it('sets the SDK auto-properties', () => {
    const e = toEvent('my.custom', SESSION, 'user_1')
    expect(e?.autoProperties.$lib.value.case).toBe('stringValue')
    expect(e?.autoProperties.$sdkVersion.value.case).toBe('stringValue')
    expect(e?.autoProperties.$platform.value.value).toBe('server')
  })

  it('returns null when the event fails validation (non-UUID sessionId)', () => {
    expect(toEvent('my.custom', 'not-a-uuid', 'user_1')).toBeNull()
  })

  it('drops non-representable property values', () => {
    const e = toEvent('my.custom', SESSION, 'user_1', { bad: Number.POSITIVE_INFINITY, good: 'x' })
    expect(e?.customProperties.bad).toBeUndefined()
    expect(e?.customProperties.good?.value.case).toBe('stringValue')
  })
})

describe('well-known events', () => {
  it('generated a non-empty server catalog', () => {
    expect(Object.keys(wellKnownSchemas).length).toBeGreaterThan(0)
  })

  it('maps known fields through their proto scalar type', () => {
    // `purchase` has: amount (double), quantity (int32), currency (string).
    const e = toEvent('purchase', SESSION, 'user_1', { amount: 9.99, quantity: 2, currency: 'USD' })
    expect(e).not.toBeNull()
    const cp = e?.customProperties
    expect(cp?.amount.value.case).toBe('doubleValue')
    expect(cp?.quantity.value.case).toBe('intValue')
    expect(cp?.currency.value.case).toBe('stringValue')
  })

  it('preserves double-vs-int from the field type, not the JS value', () => {
    // `amount` is a proto double; a whole-number 10 must stay doubleValue even though the
    // custom-event heuristic would classify 10 as an int. This is the core well-known invariant.
    const e = toEvent('purchase', SESSION, 'user_1', { amount: 10, quantity: 1, currency: 'USD' })
    expect(e?.customProperties.amount.value.case).toBe('doubleValue')
    expect(e?.customProperties.quantity.value.case).toBe('intValue')
  })

  it('routes unknown props through the heuristic as extras', () => {
    const e = toEvent('purchase', SESSION, 'user_1', { amount: 5, quantity: 1, currency: 'USD', referrer: 'news' })
    expect(e?.customProperties.referrer?.value.case).toBe('stringValue')
    // Unset known fields are not emitted.
    expect(e?.customProperties.productId).toBeUndefined()
  })

  it('drops the event (returns null) when a known field violates its proto type', () => {
    // `quantity` is int32; a non-integer fails proto construction/validation → drop.
    const e = toEvent('purchase', SESSION, 'user_1', { quantity: 1.5 })
    expect(e).toBeNull()
  })
})

// A kind matching an Object.prototype member would otherwise resolve to the inherited
// function and throw out of toEvent, which is documented to return null instead.
it('treats a prototype-named kind as a custom event', () => {
  const e = toEvent('toString', SESSION, 'user_1', { a: 1 })
  expect(e?.kind).toBe('toString')
  expect(e?.customProperties.a.value.value).toBe(1n)
})

describe('toEvent occurTime', () => {
  it('honors an explicit epoch-millisecond timestamp', () => {
    const e = toEvent('my.custom', SESSION, 'user_1', {}, { timestamp: 1_700_000_000_000 })
    expect(e?.occurTime?.seconds).toBe(1_700_000_000n)
  })

  it('preserves an explicit epoch-0 timestamp instead of treating 0 as unset', () => {
    // Regression: `0` is falsy, so a naive `opts.timestamp && …` guard silently dropped it.
    const e = toEvent('my.custom', SESSION, 'user_1', {}, { timestamp: 0 })
    expect(e?.occurTime?.seconds).toBe(0n)
  })

  it('ignores an out-of-range timestamp (unit mistake) and falls back to now with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
    // 1.7e18 looks like nanoseconds/microseconds; it must not produce a year-55-million event.
    const e = toEvent('my.custom', SESSION, 'user_1', {}, { timestamp: 1_700_000_000_000_000_000 })
    expect(warn).toHaveBeenCalled()
    expect(e?.occurTime?.seconds).toBeGreaterThanOrEqual(nowSeconds)
    expect(e?.occurTime?.seconds).toBeLessThan(nowSeconds + 60n)
    warn.mockRestore()
  })
})

describe('toEvent location', () => {
  const location = (loc: unknown) =>
    toEvent('my.custom', SESSION, 'user_1', undefined, { location: loc as EventLocation })
  const BASE_KEYS = ['$lib', '$platform', '$sdkVersion']

  it('renders every location field as a geo auto-property', () => {
    const ap = location({
      continent: 'EU',
      country: 'DE',
      region: 'Berlin',
      city: ' Berlin ',
      postalCode: '10115',
      metroCode: '807',
      timezone: 'Europe/Berlin',
      latitude: 52.52,
      longitude: 13.405,
    })?.autoProperties
    expect(ap?.$continent.value.value).toBe('EU')
    expect(ap?.$country.value.value).toBe('DE')
    expect(ap?.$region.value.value).toBe('Berlin')
    expect(ap?.$city.value.value).toBe('Berlin')
    expect(ap?.$postalCode.value.value).toBe('10115')
    expect(ap?.$metroCode.value.value).toBe('807')
    expect(ap?.$timezone.value.value).toBe('Europe/Berlin')
    expect(ap?.$latitude.value.value).toBe(52.52)
    expect(ap?.$longitude.value.value).toBe(13.405)
  })

  // A whole-number coordinate must not land in the int slot: every other writer of these
  // keys uses Float64, and the two are different ClickHouse Variant slots.
  it('always renders coordinates as doubleValue', () => {
    const e = location({ latitude: 52, longitude: 13 })
    expect(e?.autoProperties.$latitude.value.case).toBe('doubleValue')
    expect(e?.autoProperties.$longitude.value.case).toBe('doubleValue')
  })

  it('accepts coordinates at the poles and the antimeridian', () => {
    const e = location({ latitude: -90, longitude: 180 })
    expect(e?.autoProperties.$latitude.value.value).toBe(-90)
    expect(e?.autoProperties.$longitude.value.value).toBe(180)
  })

  it('bounds latitude at 90 and longitude at 180', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(location({ latitude: 100, longitude: 13 })?.autoProperties.$latitude).toBeUndefined()
    expect(location({ latitude: 45, longitude: 100 })?.autoProperties.$longitude.value.value).toBe(100)
    warn.mockRestore()
  })

  // A lone coordinate reads as a real position with the other axis at 0.
  it('drops a coordinate that has lost its pair', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = location({ latitude: 52.52, city: 'Berlin' })
    expect(e?.autoProperties.$latitude).toBeUndefined()
    expect(e?.autoProperties.$city.value.value).toBe('Berlin')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('must be set together'))
    warn.mockRestore()
  })

  it('normalizes country case and spacing', () => {
    expect(location({ country: ' de ' })?.autoProperties.$country.value.value).toBe('DE')
  })

  it('drops a country outside the ISO set with a warning, keeping the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = location({ country: 'XX', city: 'Berlin' })
    expect(e?.autoProperties.$country).toBeUndefined()
    expect(e?.autoProperties.$city.value.value).toBe('Berlin')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ISO 3166-1'))
    warn.mockRestore()
  })

  // The slot follows the declared field, not the runtime value: a JS caller (or a parsed
  // request body) that sends a number for a string field would otherwise file it in the
  // wrong Variant slot, and skip the country check entirely.
  it('drops a wrong-typed field with a warning, keeping the event', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = location({ country: 49, latitude: '52', city: 'Berlin' })
    expect(e?.autoProperties.$country).toBeUndefined()
    expect(e?.autoProperties.$latitude).toBeUndefined()
    expect(e?.autoProperties.$city.value.value).toBe('Berlin')
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  // TypeScript only catches this on a fresh literal, and this option exists to carry values
  // out of a parsed request body.
  it('warns about a key that is not a location field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = location({ country: 'DE', citty: 'Berlin' })
    expect(e?.autoProperties.$country.value.value).toBe('DE')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown location field "citty"'))
    warn.mockRestore()
  })

  // `in` would match these off Object.prototype and skip the warning.
  it('warns about a key that shadows a prototype member', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = location({ country: 'DE', toString: 'Berlin' })
    expect(e?.autoProperties.$country.value.value).toBe('DE')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown location field "toString"'))
    warn.mockRestore()
  })

  it('warns when location is not an object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = location('Berlin')
    expect(Object.keys(e?.autoProperties ?? {}).sort()).toEqual(BASE_KEYS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected an object'))
    warn.mockRestore()
  })

  // A null field is "unknown", not a mistake: it must cost the field, never the event.
  it('treats a null field as absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = location({ country: 'DE', city: null })
    expect(e?.autoProperties.$country.value.value).toBe('DE')
    expect(e?.autoProperties.$city).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('omits empty, out-of-range and non-finite values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = location({ city: '  ', latitude: Number.NaN, longitude: 200, country: 'DE' })
    expect(e?.autoProperties.$city).toBeUndefined()
    expect(e?.autoProperties.$latitude).toBeUndefined()
    expect(e?.autoProperties.$longitude).toBeUndefined()
    expect(e?.autoProperties.$country.value.value).toBe('DE')
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  // Silence here would look identical to sending no location at all, while the event ships
  // with no geo whatsoever — nothing on the server fills it in.
  it('warns when no field is usable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = location({ city: '', country: '' })
    expect(Object.keys(e?.autoProperties ?? {}).sort()).toEqual(BASE_KEYS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable fields'))
    warn.mockRestore()
  })

  it('writes no geo keys when no location is given', () => {
    const e = toEvent('my.custom', SESSION, 'user_1')
    expect(Object.keys(e?.autoProperties ?? {}).sort()).toEqual(BASE_KEYS)
  })
})
