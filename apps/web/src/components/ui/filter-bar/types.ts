import type { Component } from 'vue'

/**
 * A Linear-style filter bar: each active filter is a chip reading
 * `field · operator · value`, and an unfilled chip is a no-op rather than a
 * contradiction, so a half-built filter never hides rows.
 *
 * The bar is data-driven — a page hands it `fields` and gets back
 * `ActiveFilter[]`. Turning those into a predicate is `matchesFilters`, which
 * keeps the matching rules in one place instead of once per page.
 */

export type FilterOperator = 'is' | 'is-not' | 'contains' | 'not-contains'

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  'is': 'is',
  'is-not': 'is not',
  'contains': 'contains',
  'not-contains': 'excludes',
}

export interface FilterOption {
  /** Stable identity; what `ActiveFilter.values` carries. */
  value: string
  label: string
  icon?: Component
  /** Muted trailing metadata — a real count, not decoration. */
  meta?: string | number
}

export interface FilterField {
  key: string
  label: string
  icon?: Component
  /**
   * Section heading in the field picker. Fields sharing a group are listed
   * together, in first-seen order; ungrouped fields lead.
   */
  group?: string
  /** `select` (default) picks from `options`; `text` takes a typed string. */
  type?: 'select' | 'text'
  options?: FilterOption[]
  /** Defaults to is/is-not for selects, contains/excludes for text. */
  operators?: FilterOperator[]
  /** Multi-value selects read as "is any of"; `false` picks exactly one. */
  multiple?: boolean
  /**
   * A scope rather than a predicate — always on the bar, never offered in the
   * picker, and untouched by Clear. Use it for the axis a page is *always*
   * viewed along (the workspace whose roster is shown), so it reads as one
   * control with the filters instead of a stray field above them.
   *
   * Pin fields the page resolves itself: the bar will not add or remove them.
   */
  pinned?: boolean
  /** Placeholder for a `text` field's value input. */
  placeholder?: string
}

export interface ActiveFilter {
  key: string
  operator: FilterOperator
  /** Empty means "not filled in yet" — such a filter matches everything. */
  values: string[]
}

export function defaultOperators(field: FilterField): FilterOperator[] {
  if (field.operators?.length) return field.operators
  return field.type === 'text' ? ['contains', 'not-contains'] : ['is', 'is-not']
}
