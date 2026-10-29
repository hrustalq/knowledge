/**
 * What the knowledge-health page (docs/features/40, issue #66 phase 6) shares
 * between its parts: the preset list and the shape of a bulk request.
 *
 * A preset is a `HealthFilter` or `all`. The API has no "all" — an omitted
 * filter lists every live page — so the word exists only here, as the strip's
 * first chip, and is translated back into "no filter" at the one place the
 * query is built.
 */
import { HEALTH_FILTERS, type HealthBulkAction, type HealthFilter } from '@knowledge/contracts'

export type HealthPreset = 'all' | HealthFilter

export const HEALTH_PRESETS: readonly HealthPreset[] = ['all', ...HEALTH_FILTERS]

export function isHealthPreset(value: unknown): value is HealthPreset {
  return typeof value === 'string' && (HEALTH_PRESETS as readonly string[]).includes(value)
}

/** One bulk action as the bar hands it up; the page adds the workspace and the ids. */
export interface HealthBulkRequest {
  action: HealthBulkAction
  intervalDays?: number | null
  note?: string
  ownerId?: string | null
}

export type HealthSort = 'activity' | 'title'
export const HEALTH_SORTS: readonly HealthSort[] = ['activity', 'title']

/** Rows per request — a fetch size, the list continues with "Load more". */
export const HEALTH_PAGE = 50
