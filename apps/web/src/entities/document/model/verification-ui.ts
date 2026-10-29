/**
 * The page-level verification surfaces (docs/features/39, issue #66 phase 5)
 * share one reading of a state: the status bar, the tree rows, the search
 * results and the list all draw from here, so a page cannot be amber in the
 * rail and red in the sheet.
 *
 * `verificationTone` itself lives in `lib/verification-tone` — the provenance
 * chips read it too — and is re-exported rather than copied.
 */
import type { SourceVerificationState, VerificationSource } from '@knowledge/contracts'
import { verificationTone } from '@/entities/document/model/verification-tone'

export { verificationTone }

/**
 * Tailwind background for the small mark a tree row or a list row carries.
 * Panel-ramp hues, not emerald/amber/red: those belong to the indexing dot,
 * which sits in the same row, and a page that is indexing must not read as a
 * page that is outdated.
 */
export function verificationDotClass(state: SourceVerificationState | undefined): string {
  switch (verificationTone(state)) {
    case 'ok':
      return 'bg-panel-tip'
    case 'warn':
      return 'bg-panel-warning'
    case 'bad':
      return 'bg-panel-caution'
    default:
      return 'bg-muted-foreground/40'
  }
}

/**
 * The mark's shape on a row: a small diamond, so it is told apart from the
 * round indexing dot beside it by outline as well as by hue.
 */
export const VERIFICATION_MARK_CLASS = 'size-1.5 shrink-0 rotate-45 rounded-[1px]'

/**
 * A row draws a verification mark only when the state asks for a look. A
 * verified page and an unverified one are the normal states of a knowledge
 * base; marking either on every row would make the mark mean nothing.
 */
export function needsAttention(state: SourceVerificationState | undefined): boolean {
  const tone = verificationTone(state)
  return tone === 'warn' || tone === 'bad'
}

/**
 * Review-interval choices offered by the verify menu, in days. `null` inherits
 * the workspace default and `0` never expires — the same two meanings the API
 * gives `intervalDays` and `reviewIntervalDays`.
 */
export const INTERVAL_CHOICES = [null, 30, 90, 180, 365, 0] as const
export type IntervalChoice = (typeof INTERVAL_CHOICES)[number]

/** The menu's string value for an interval; the inverse is `intervalFromKey`. */
export function intervalKey(days: number | null | undefined): string {
  if (days === null || days === undefined) return 'default'
  if (days === 0) return 'never'
  return String(days)
}

export function intervalFromKey(key: string): number | null {
  if (key === 'default') return null
  if (key === 'never') return 0
  const n = Number(key)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Who set a flag, as the sentence on the bar names them. `person` resolves to
 * a member name at the call site; the agents are named by role, since a run
 * owner is who an agent acted *for*, not who said the page is wrong.
 */
export type FlagSourceWho = 'person' | 'sentinel' | 'curator' | 'mcp' | 'someone'

export function flagSourceWho(source: VerificationSource | null | undefined): FlagSourceWho {
  switch (source?.kind) {
    case 'person':
      return source.by ? 'person' : 'someone'
    case 'drift':
      return 'sentinel'
    case 'curator':
      return 'curator'
    case 'mcp':
      return 'mcp'
    default:
      return 'someone'
  }
}
