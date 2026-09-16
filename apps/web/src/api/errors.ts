import type { ApiErrorCode } from '@knowledge/contracts'
import { ApiError } from '@/lib/api'
import { ApiRequestError } from '@/api/http'

/**
 * One place that turns any thrown request error into something to show a user.
 *
 * The app runs two HTTP stacks — `apiFetch` in lib/api.ts throws `ApiError`,
 * the generated client throws `ApiRequestError` — so every call site that
 * wanted a readable message either handled one and not the other, or gave up
 * and toasted `error.message`. For a 413 that message used to be the raw
 * response body, which is how `500 Internal Server Error: {"statusCode":500,…}`
 * ended up in front of someone who had merely pasted a long page.
 *
 * Branch on `code`, never on message text: the message is translated, so any
 * prefix or substring match against it breaks in Russian.
 */

/** The translator, narrowed to what this needs — avoids a vue-i18n type import. */
type Translate = (key: string) => string

function codeOf(error: unknown): ApiErrorCode | undefined {
  if (error instanceof ApiRequestError) return error.code
  if (error instanceof ApiError) return error.code
  return undefined
}

function firstValidationError(error: unknown): string | undefined {
  const details = error instanceof ApiRequestError ? error.details : undefined
  const errors = details?.errors
  return Array.isArray(errors) && typeof errors[0] === 'string' ? errors[0] : undefined
}

export function errorMessage(error: unknown, t: Translate): string {
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
