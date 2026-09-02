// Generated, strictly-typed API client. Regenerate with `make api-client`.
export { api, request, type ApiData, type ApiPaths, type Op, type RequestOptions } from './client'
export { http, ApiRequestError, isApiRequestError, toApiRequestError } from './http'
export { createQueryClient, apiQueryOptions, apiMutationOptions } from './queries'
export {
  apiQueryOptions as queryOptions,
  useApiMutation,
  type OptimisticPatch,
  type OptimisticSpec,
} from './queries'
export { LiveClient, type LiveEventListener, type LiveErrorListener } from './live'
export {
  startLive,
  stopLive,
  liveClient,
  applyLiveEvent,
  defaultLiveCacheRules,
  type LiveCacheRule,
  type StartLiveOptions,
} from './live-cache'
