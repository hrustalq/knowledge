import { errorMessage as requestErrorMessage } from '@knowledge/api-client'
import { UploadError } from '@/shared/api/presigned-put'

// What any app shows for a request error lives in @knowledge/api-client (#1236);
// this app adds the one error only it throws, a presigned upload's.
export { errorDetails, errorReason, isRestrictedRefusal } from '@knowledge/api-client'

/** The translator, narrowed to what this needs — avoids a vue-i18n type import. */
type Translate = (key: string, params?: Record<string, unknown>) => string

export function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof UploadError) return t(error.key, error.params)
  return requestErrorMessage(error, t)
}
