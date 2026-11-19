// Axios HTTP core for the generated API client (src/shared/api/client.ts).
// The error contract (ApiRequestError, toApiRequestError) is
// @knowledge/api-client's, shared with apps/admin (#1236); this file owns what
// is this app's: the base URL, the credential, the locale, the trace id and
// what a re-auth refusal does.
import axios, { type AxiosInstance } from 'axios'
import { CSRF_HEADER } from '@knowledge/contracts'
import { toApiRequestError } from '@knowledge/api-client'
import { getLocale, getToken, requestTraceId } from '@/shared/api/api'
import { redirectForReauth } from '@/shared/api/reauth'

export { ApiRequestError, isApiRequestError, toApiRequestError } from '@knowledge/api-client'

// Same base-URL rules as shared/api/api.ts: SSR talks to the API directly, the
// browser goes through the Vite /api proxy (no CORS).
const base = import.meta.env.SSR
  ? (process.env.API_URL_INTERNAL ?? 'http://localhost:3000')
  : (import.meta.env.VITE_API_URL ?? '/api')

export const http: AxiosInstance = axios.create({ baseURL: base, timeout: 30_000 })

http.interceptors.request.use((config) => {
  // In the browser the HttpOnly session cookie authenticates the call (#650)
  // and getToken() is null; the SSR render forwards the request's cookie as a
  // bearer. A call may ask as another credential (Connect AI checks a key it
  // just minted): its own header wins over the session's.
  const token = getToken()
  if (token && !config.headers.has('Authorization')) config.headers.set('Authorization', `Bearer ${token}`)
  // What lets the API accept a cookie-authenticated write: a cross-site form cannot send it.
  for (const [name, value] of Object.entries(CSRF_HEADER)) config.headers.set(name, value)
  // Second HTTP stack, same contract: the API replies in the UI's language.
  config.headers.set('Accept-Language', getLocale())
  // Correlates this call to the API's logs — and, under SSR, to the page render
  // and the browser request that triggered it.
  config.headers.set('x-request-id', requestTraceId())
  return config
})

http.interceptors.response.use(undefined, (error: unknown) => {
  const normalized = toApiRequestError(error)
  // Enforced SSO (#75): a 403 that asks for a fresh sign-in navigates to /login.
  redirectForReauth(normalized.status, normalized.details)
  return Promise.reject(normalized)
})
