// The typed client both web apps share (@knowledge/api-client), bound to this
// app's axios instance.
import { createApiClient } from '@knowledge/api-client'
import { http } from './http'

export type { ApiData, ApiPaths, Op, RequestOptions } from '@knowledge/api-client'

export const { api, request, requestFile } = createApiClient(http)
