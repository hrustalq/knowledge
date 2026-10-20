import type { SourceVerificationState } from '@knowledge/contracts'

/**
 * The hue a verification state takes; `none` is "nothing to say", drawn muted.
 * Warn for a stamp that no longer quite holds (edited since, expired, asked
 * to re-check); bad for a page somebody says is wrong (docs/features/39).
 */
export function verificationTone(state: SourceVerificationState | undefined): 'ok' | 'warn' | 'bad' | 'none' {
  switch (state) {
    case 'verified':
      return 'ok'
    case 'edited':
    case 'expired':
    case 'requested':
      return 'warn'
    case 'outdated':
    case 'flagged':
      return 'bad'
    default:
      return 'none'
  }
}
