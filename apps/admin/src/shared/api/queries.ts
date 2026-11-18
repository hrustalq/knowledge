// vue-query for the console: the shared option builders, bound to this app's
// client. Every query keeps the default freshness until a section says
// otherwise.
import type { QueryClient } from '@tanstack/vue-query'
import { createQueryHelpers } from '@knowledge/api-client/vue-query'
import { api, request } from './client'

export { createQueryClient, type OptimisticPatch, type OptimisticSpec } from '@knowledge/api-client/vue-query'
export { api }
export { ApiRequestError, isApiRequestError } from './http'

declare module 'pinia' {
  export interface PiniaCustomProperties {
    /** This app's query client, installed by main.ts. */
    queryClient: QueryClient
  }
}

export const { apiQueryOptions, fetchApi, apiInfiniteQueryOptions, apiMutationOptions, useApiMutation } = createQueryHelpers({
  api,
  request,
})
