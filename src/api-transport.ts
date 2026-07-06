import type { Transport } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { DEFAULT_TIMEOUT_MS } from './utils.js'

/** Builds a Connect transport that attaches the project API key to every request. */
export const createApiTransport = (
  endpoint: string,
  apiKey: string,
  opts?: { defaultTimeoutMs?: number },
): Transport => {
  return createConnectTransport({
    baseUrl: endpoint,
    httpVersion: '1.1',
    defaultTimeoutMs: opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    interceptors: [
      next => async req => {
        req.header.set('x-api-key', apiKey)
        return next(req)
      },
    ],
    useBinaryFormat: true,
  })
}
