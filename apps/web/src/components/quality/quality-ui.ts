/**
 * Shared pieces of the docs quality surfaces (#74, phase 5): the Quality tab
 * of knowledge health, the page rail and the project widget.
 *
 * Colour follows the design system's reserved-signal rule: emerald, amber and
 * red belong to the indexing lifecycle, so a score is never painted green or
 * red. A score is ink; only a score **below the auditor's threshold** takes
 * the caution panel hue — the same line past which the auditor files a
 * finding, read from the API rather than restated here.
 */
import { QUALITY_BANDS, QUALITY_DIMENSIONS, type QualityDimension, type QualityIssueSeverity } from '@knowledge/contracts'

export { QUALITY_DIMENSIONS }

export const isLow = (score: number | null | undefined, threshold: number): boolean =>
  typeof score === 'number' && score < threshold

/** Text colour for a score: ink, or the caution hue below the threshold. */
export function scoreTone(score: number | null | undefined, threshold: number): string {
  return isLow(score, threshold) ? 'text-[color:var(--kn-panel-caution)]' : 'text-foreground'
}

/** "0–19", "20–39", …, "80–100" — the distribution's band labels. */
export function bandLabel(index: number): string {
  const floor = QUALITY_BANDS[index]
  const next = QUALITY_BANDS[index + 1]
  return `${floor}–${next === undefined ? 100 : next - 1}`
}

/** A band lies below the threshold when every score in it does. */
export function bandIsLow(index: number, threshold: number): boolean {
  const next = QUALITY_BANDS[index + 1]
  return (next === undefined ? 101 : next) <= threshold
}

/**
 * A history point's `YYYY-MM-DD` as a Date at noon UTC, so a reader west of
 * Greenwich does not see the audit filed under the day before.
 */
export const historyDay = (date: string): Date => new Date(`${date}T12:00:00Z`)

/** The panel hue an issue's severity is marked with — never its only cue. */
export const SEVERITY_HUE: Record<QualityIssueSeverity, string> = {
  error: 'var(--kn-panel-caution)',
  warning: 'var(--kn-panel-warning)',
  info: 'var(--kn-panel-note)',
}

export type { QualityDimension }
