import { Code, ConnectError } from '@connectrpc/connect'
import { describe, expect, it } from 'vitest'
import { PugError, toPugError } from './errors.js'

describe('toPugError', () => {
  it('returns an existing PugError unchanged', () => {
    const original = new PugError('boom', { code: Code.NotFound })
    expect(toPugError(original)).toBe(original)
  })

  it('preserves the Connect code and cause from a ConnectError', () => {
    const connect = new ConnectError('denied', Code.PermissionDenied)
    const err = toPugError(connect)
    expect(err).toBeInstanceOf(PugError)
    expect(err.code).toBe(Code.PermissionDenied)
    expect(err.cause).toBe(connect)
    expect(err.message).toBe('denied')
  })

  it('wraps a generic Error with its message and no code', () => {
    const generic = new Error('kaboom')
    const err = toPugError(generic)
    expect(err).toBeInstanceOf(PugError)
    expect(err.code).toBeUndefined()
    expect(err.cause).toBe(generic)
    expect(err.message).toBe('kaboom')
  })

  it('stringifies a non-Error thrown value', () => {
    const err = toPugError('just a string')
    expect(err.message).toBe('just a string')
    expect(err.code).toBeUndefined()
    expect(err.cause).toBe('just a string')
  })
})
