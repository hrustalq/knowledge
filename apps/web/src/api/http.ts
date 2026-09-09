// Axios HTTP core for the generated API client (src/api/client.ts).
// Strict error contract: EVERY failed request rejects with ApiRequestError
// carrying a normalized @knowledge/contracts ApiErrorPayload — HTTP errors,
// malformed bodies, network failures, timeouts and aborts all included.
import axios, { AxiosError, type AxiosInstance } from 'axios'
import {
  errorCodeForStatus,
  isApiErrorPayload,
  type ApiErrorCode,
  type ApiErrorPayload,
} from '@knowledge/contracts'
import { getLocale, getToken } from '@/lib/api'

export class ApiRequestError extends Error {
  readonly payload: ApiErrorPayload

  constructor(payload: ApiErrorPayload, options?: ErrorOptions) {
    super(payload.message, options)
    this.name = 'ApiRequestError'
    this.payload = payload
  }

  /** HTTP status (0 = never reached the server: network/timeout/abort). */
  get status(): number {
    return this.payload.statusCode
  }

  /** Stable machine-readable code — branch on this, never on message. */
  get code(): ApiErrorCode {
    return this.payload.code
  }

  get details(): Record<string, unknown> | undefined {
    return this.payload.details
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError
}

function synthesize(partial: Pick<ApiErrorPayload, 'statusCode' | 'code' | 'message'> & Partial<ApiErrorPayload>): ApiErrorPayload {
  return { path: '', requestId: '', timestamp: new Date().toISOString(), ...partial }
}

/** Normalize ANY thrown value into an ApiRequestError (idempotent). */
export function toApiRequestError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) return error

  if (axios.isAxiosError(error)) {
    const path = error.config?.url ?? ''
    const response = error.response
    if (response) {
      // Conforming envelope from the API filter — pass through verbatim.
      if (isApiErrorPayload(response.data)) return new ApiRequestError(response.data, { cause: error })
      // Non-conforming body (proxy error page, legacy shape) — synthesize.
      const body = response.data
      return new ApiRequestError(
        synthesize({
          statusCode: response.status,
          code: errorCodeForStatus(response.status),
          message: typeof body === 'string' && body.length > 0 ? body.slice(0, 300) : error.message,
          path,
          requestId: String(response.headers?.['x-request-id'] ?? ''),
        }),
        { cause: error },
      )
    }
    const code: ApiErrorCode =
      error.code === AxiosError.ECONNABORTED || error.code === AxiosError.ETIMEDOUT
        ? 'TIMEOUT'
        : error.code === AxiosError.ERR_CANCELED
          ? 'ABORTED'
          : 'NETWORK_ERROR'
    return new ApiRequestError(synthesize({ statusCode: 0, code, message: error.message, path }), { cause: error })
  }

  return new ApiRequestError(
    synthesize({ statusCode: 0, code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }),
    { cause: error },
  )
}

// Same base-URL rules as lib/api.ts: SSR talks to the API directly, the
// browser goes through the Vite /api proxy (no CORS).
const base = import.meta.env.SSR
  ? (process.env.API_URL_INTERNAL ?? 'http://localhost:3000')
  : (import.meta.env.VITE_API_URL ?? '/api')

export const http: AxiosInstance = axios.create({ baseURL: base, timeout: 30_000 })

http.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.set('Authorization', `Bearer ${token}`)
  // Second HTTP stack, same contract: the API replies in the UI's language.
  config.headers.set('Accept-Language', getLocale())
  return config
})

http.interceptors.response.use(undefined, (error: unknown) => Promise.reject(toApiRequestError(error)))
