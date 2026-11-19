// The typed API client both web apps share (#1236): apps/web and apps/admin.
//   make api-client → regenerates apps/api/openapi.json + src/schema.d.ts here
// Paths, methods, path/query params and request bodies are all checked against
// the schema at compile time. Strict error contract: EVERY failed request
// rejects with ApiRequestError carrying a normalized @knowledge/contracts
// ApiErrorPayload — HTTP errors, malformed bodies, network failures, timeouts
// and aborts all included.
//
// What differs per app (base URL, credential, locale, trace id, what a refusal
// does) stays in the app: it builds its own axios instance, normalizes errors
// with `toApiRequestError` in a response interceptor, and binds the client to
// it with `createApiClient(http)`.
import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios'
import type { HttpMethod, OperationRequestBodyContent, PathsWithMethod } from 'openapi-typescript-helpers'
import { errorCodeForStatus, isApiErrorPayload, type ApiErrorCode, type ApiErrorPayload } from '@knowledge/contracts'
import type { paths } from '@knowledge/api-client/schema'

export type ApiPaths = paths
export type Op<P extends keyof paths, M extends HttpMethod> = M extends keyof paths[P] ? paths[P][M] : never

type SuccessCode = 200 | 201 | 202 | 204 | '2XX'
type JsonContentOf<R> = R extends { content: { 'application/json': infer J } } ? J : unknown
type SuccessBody<O> = O extends { responses: infer R }
  ? { [K in keyof R & SuccessCode]: JsonContentOf<R[K]> }[keyof R & SuccessCode]
  : unknown

/** JSON body of the operation's 2xx response; `unknown` while the schema declares no response content (add @ApiOkResponse({ type }) server-side to tighten). */
export type ApiData<O> = [SuccessBody<O>] extends [never] ? unknown : SuccessBody<O>

type ParamsOf<O> = O extends { parameters: infer P } ? P : never
type QueryOf<O> = ParamsOf<O> extends { query?: infer Q } ? NonNullable<Q> : never
type PathParamsOf<O> = ParamsOf<O> extends { path: infer PP } ? PP : never

export interface RequestOptions<O> {
  path?: [PathParamsOf<O>] extends [never] ? Record<string, never> : PathParamsOf<O>
  query?: [QueryOf<O>] extends [never] ? Record<string, never> : QueryOf<O>
  body?: [OperationRequestBodyContent<O>] extends [never] ? never : OperationRequestBodyContent<O>
  /** Cancels the request (axios) — vue-query passes its per-query signal here, so unmount/refetch aborts in-flight requests. Rejections surface as ApiRequestError code 'ABORTED'. */
  signal?: AbortSignal
  config?: AxiosRequestConfig
}

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

/** Fill `{param}` templates; throws early on a missing param instead of sending a broken URL. */
function buildUrl(template: string, pathParams?: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = pathParams?.[key]
    if (value === undefined || value === null) throw new Error(`Missing path param "${key}" for ${template}`)
    return encodeURIComponent(String(value))
  })
}

/** The typed entrypoints, bound to one app's axios instance. */
export function createApiClient(http: AxiosInstance) {
  async function request<M extends HttpMethod, P extends PathsWithMethod<paths, M>>(
    method: M,
    url: P,
    opts?: RequestOptions<Op<P, M>>,
  ): Promise<ApiData<Op<P, M>>> {
    const res = await http.request({
      method,
      url: buildUrl(url as string, opts?.path as Record<string, unknown> | undefined),
      params: opts?.query,
      data: opts?.body,
      signal: opts?.signal,
      ...opts?.config,
    })
    return res.data as ApiData<Op<P, M>>
  }

  /**
   * A route that answers a file (`GET /v1/ai/feedback/export`). `<a href>` cannot
   * send the Authorization header, so the bytes come through the client and the
   * caller hands them to the browser.
   */
  async function requestFile<M extends HttpMethod, P extends PathsWithMethod<paths, M>>(
    method: M,
    url: P,
    opts?: RequestOptions<Op<P, M>>,
  ): Promise<{ blob: Blob; filename: string | null }> {
    const res = await http.request<Blob>({
      method,
      url: buildUrl(url as string, opts?.path as Record<string, unknown> | undefined),
      params: opts?.query,
      data: opts?.body,
      signal: opts?.signal,
      responseType: 'blob',
      ...opts?.config,
    })
    const disposition = String(res.headers['content-disposition'] ?? '')
    const match = /filename="?([^";]+)"?/.exec(disposition)
    return { blob: res.data, filename: match?.[1] ?? null }
  }

  /** Method-scoped entrypoints: `api.get('/v1/documents/{id}', { path: { id } })`. */
  const api = {
    get: <P extends PathsWithMethod<paths, 'get'>>(url: P, opts?: RequestOptions<Op<P, 'get'>>) => request('get', url, opts),
    post: <P extends PathsWithMethod<paths, 'post'>>(url: P, opts?: RequestOptions<Op<P, 'post'>>) => request('post', url, opts),
    patch: <P extends PathsWithMethod<paths, 'patch'>>(url: P, opts?: RequestOptions<Op<P, 'patch'>>) =>
      request('patch', url, opts),
    put: <P extends PathsWithMethod<paths, 'put'>>(url: P, opts?: RequestOptions<Op<P, 'put'>>) => request('put', url, opts),
    delete: <P extends PathsWithMethod<paths, 'delete'>>(url: P, opts?: RequestOptions<Op<P, 'delete'>>) =>
      request('delete', url, opts),
  }

  return { api, request, requestFile }
}

/** The translator, narrowed to what the helpers below need — avoids a vue-i18n type import. */
type Translate = (key: string, params?: Record<string, unknown>) => string

function firstValidationError(error: unknown): string | undefined {
  const errors = errorDetails(error)?.errors
  return Array.isArray(errors) && typeof errors[0] === 'string' ? errors[0] : undefined
}

/**
 * One place that turns any thrown request error into something to show a user.
 *
 * Before it, call sites toasted `error.message`, and for a 413 that used to be
 * the raw response body — which is how `500 Internal Server Error:
 * {"statusCode":500,…}` ended up in front of someone who had merely pasted a
 * long page.
 *
 * Branch on `code`, never on message text: the message is translated, so any
 * prefix or substring match against it breaks in Russian. Reads two keys from
 * the app's catalogue: `common.tooLarge` and `common.unknownError`.
 */
export function errorMessage(error: unknown, t: Translate): string {
  const code = error instanceof ApiRequestError ? error.code : undefined
  // The server's own wording is accurate but generic; the UI can say the one thing the user can act on.
  if (code === 'PAYLOAD_TOO_LARGE') return t('common.tooLarge')
  // details.errors[0] is the specific field failure ("text must be at most
  // 500000 characters long"); the envelope message is just "Validation failed".
  const specific = code === 'VALIDATION_FAILED' ? firstValidationError(error) : undefined
  const message = specific ?? (error instanceof Error ? error.message.trim() : '')
  return message.length > 0 ? message : t('common.unknownError')
}

/** The envelope's `details`, or undefined. */
export function errorDetails(error: unknown): Record<string, unknown> | undefined {
  return error instanceof ApiRequestError ? error.details : undefined
}

/**
 * `details.reason` — the stable discriminator a 409 carries when one status
 * covers several refusals (`access.selfLockout`, `share.restricted`, #76).
 */
export function errorReason(error: unknown): string | undefined {
  const reason = errorDetails(error)?.reason
  return typeof reason === 'string' ? reason : undefined
}

/**
 * A member opened a restricted page they were not granted (#76): the API
 * answers 403 with `details.canRequestAccess`, and never the page's title.
 */
export function isRestrictedRefusal(error: unknown): boolean {
  const status = error instanceof ApiRequestError ? error.status : 0
  return status === 403 && errorDetails(error)?.canRequestAccess === true
}
