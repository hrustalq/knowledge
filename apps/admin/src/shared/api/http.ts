// The console's axios instance (#1236), the counterpart of apps/web's
// shared/api/http.ts. The error contract is @knowledge/api-client's.
//
// The browser is authenticated by the member app's HttpOnly session cookie
// (#650), which reaches /admin because the console is served on the same host.
// So there is no token here, only the CSRF header that lets the API accept a
// cookie-authenticated write.
import axios, { type AxiosInstance } from 'axios'
import { CSRF_HEADER, DEFAULT_LOCALE, type Locale } from '@knowledge/contracts'
import { toApiRequestError } from '@knowledge/api-client'

export { ApiRequestError, isApiRequestError, toApiRequestError } from '@knowledge/api-client'

let locale: Locale = DEFAULT_LOCALE

/** The API answers in the console's language (set once `me` is known). */
export function setApiLocale(next: Locale): void {
  locale = next
}

export const http: AxiosInstance = axios.create({ baseURL: import.meta.env.VITE_API_URL ?? '/api', timeout: 30_000 })

http.interceptors.request.use((config) => {
  for (const [name, value] of Object.entries(CSRF_HEADER)) config.headers.set(name, value)
  config.headers.set('Accept-Language', locale)
  return config
})

http.interceptors.response.use(undefined, (error: unknown) => Promise.reject(toApiRequestError(error)))
