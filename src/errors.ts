import { Code, ConnectError } from '@connectrpc/connect'

/**
 * Error surfaced by the read methods (profiles/activity/insights). Ingestion
 * (track/identify) never throws — it logs and drops — so these are read-only.
 */
export class PugError extends Error {
  readonly code?: Code
  override readonly cause?: unknown

  constructor(message: string, opts: { code?: Code; cause?: unknown } = {}) {
    super(message)
    this.name = 'PugError'
    this.code = opts.code
    this.cause = opts.cause
  }
}

/** Normalize any thrown value into a typed PugError, preserving the Connect code. */
export const toPugError = (err: unknown): PugError => {
  if (err instanceof PugError) {
    return err
  }
  if (err instanceof ConnectError) {
    return new PugError(err.rawMessage, { code: err.code, cause: err })
  }
  return new PugError(err instanceof Error ? err.message : String(err), { cause: err })
}
