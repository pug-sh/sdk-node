import { uuidv7 } from 'uuidv7'
import { describe, expect, it, vi } from 'vitest'
import { toEvent } from './track.js'
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
