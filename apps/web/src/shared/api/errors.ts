import type { ApiErrorCode } from '@knowledge/contracts'
import { ApiRequestError } from '@/shared/api/http'
import { UploadError } from '@/shared/api/presigned-put'

/**
 * One place that turns any thrown request error into something to show a user.
 *
 * Before it, call sites toasted `error.message`, and for a 413 that used to be
 * the raw response body — which is how `500 Internal Server Error:
 * {"statusCode":500,…}` ended up in front of someone who had merely pasted a
 * long page.
 *
 * Branch on `code`, never on message text: the message is translated, so any
 * prefix or substring match against it breaks in Russian.
 */

/** The translator, narrowed to what this needs — avoids a vue-i18n type import. */
type Translate = (key: string, params?: Record<string, unknown>) => string

function codeOf(error: unknown): ApiErrorCode | undefined {
  return error instanceof ApiRequestError ? error.code : undefined
}

function firstValidationError(error: unknown): string | undefined {
  const details = error instanceof ApiRequestError ? error.details : undefined
  const errors = details?.errors
  return Array.isArray(errors) && typeof errors[0] === 'string' ? errors[0] : undefined
}

export function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof UploadError) return t(error.key, error.params)
  switch (codeOf(error)) {
    case 'PAYLOAD_TOO_LARGE':
      // The server's own wording is accurate but generic; the UI can say the
      // one thing the user can act on.
      return t('common.tooLarge')
    case 'VALIDATION_FAILED':
      // details.errors[0] is the specific field failure ("text must be at most
      // 500000 characters long"); the envelope message is just "Validation failed".
      return firstValidationError(error) ?? messageOrFallback(error, t)
    default:
      return messageOrFallback(error, t)
  }
}

function messageOrFallback(error: unknown, t: Translate): string {
  const message = error instanceof Error ? error.message.trim() : ''
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
