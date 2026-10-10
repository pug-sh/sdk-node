/** Default backend base URL used when a client is created without an explicit `endpoint`. */
export const DEFAULT_ENDPOINT = 'https://api.pugs.dev'

/** Connect's default per-request timeout for the SDK transports. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** An object literal or null-prototype object; not an array, Date, Map or class instance. */
export const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) {
    return false
  }
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
