// Typed API client generated from the OpenAPI schema.
//   make api-client   → regenerates apps/api/openapi.json + src/api/schema.d.ts
// Paths, methods, path/query params and request bodies are all checked against
// the schema at compile time; failures reject with ApiRequestError (see http.ts).
import type { AxiosRequestConfig } from 'axios'
import type {
  HttpMethod,
  OperationRequestBodyContent,
  PathsWithMethod,
} from 'openapi-typescript-helpers'
import type { paths } from './schema'
import { http } from './http'

export type ApiPaths = paths
export type Op<P extends keyof paths, M extends HttpMethod> = M extends keyof paths[P]
  ? paths[P][M]
  : never

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

/** Fill `{param}` templates; throws early on a missing param instead of sending a broken URL. */
function buildUrl(template: string, pathParams?: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = pathParams?.[key]
    if (value === undefined || value === null) throw new Error(`Missing path param "${key}" for ${template}`)
    return encodeURIComponent(String(value))
  })
}

export async function request<M extends HttpMethod, P extends PathsWithMethod<paths, M>>(
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

/** Method-scoped entrypoints: `api.get('/v1/documents/{id}', { path: { id } })`. */
export const api = {
  get: <P extends PathsWithMethod<paths, 'get'>>(url: P, opts?: RequestOptions<Op<P, 'get'>>) =>
    request('get', url, opts),
  post: <P extends PathsWithMethod<paths, 'post'>>(url: P, opts?: RequestOptions<Op<P, 'post'>>) =>
    request('post', url, opts),
  patch: <P extends PathsWithMethod<paths, 'patch'>>(url: P, opts?: RequestOptions<Op<P, 'patch'>>) =>
    request('patch', url, opts),
  put: <P extends PathsWithMethod<paths, 'put'>>(url: P, opts?: RequestOptions<Op<P, 'put'>>) =>
    request('put', url, opts),
  delete: <P extends PathsWithMethod<paths, 'delete'>>(url: P, opts?: RequestOptions<Op<P, 'delete'>>) =>
    request('delete', url, opts),
}
