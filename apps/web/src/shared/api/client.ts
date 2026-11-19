// Typed API client generated from the OpenAPI schema, shared with apps/admin
// through @knowledge/api-client (#1236).
//   make api-client   → regenerates apps/api/openapi.json + packages/api-client/src/schema.d.ts
// Bound here to this app's axios instance (http.ts), which carries the
// credential, the locale and the trace id.
import { createApiClient } from '@knowledge/api-client'
import { http } from './http'

export type { ApiData, ApiPaths, Op, RequestOptions } from '@knowledge/api-client'

export const { api, request, requestFile } = createApiClient(http)
