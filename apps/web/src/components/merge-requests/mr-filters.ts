import type { ActiveFilter, FilterOperator } from '@/components/ui/filter-bar'

/**
 * The filter bar's fields, mapped onto `GET /v1/merge-requests` query params.
 *
 * Filtering happens on the server, not with `filterRows`: the list is
 * cursor-paginated, so narrowing only the loaded page would quietly disagree
 * with the tab counts and with "Load more". Every field here is therefore a
 * param the API actually serves — and nothing else is offered.
 */
export const MR_FILTER_PARAMS = {
  author: 'authorId',
  assignee: 'assigneeId',
  reviewer: 'reviewerId',
  sourceBranch: 'sourceBranch',
  targetBranch: 'targetBranch',
} as const

export type MrFilterKey = keyof typeof MR_FILTER_PARAMS

/**
 * Active chips as query params. The API takes one value per field and has no
 * negation, so the fields are declared single-value `is` and an unfilled chip
 * contributes nothing — mid-build, it narrows to everything rather than to
 * nothing.
 */
export function mergeRequestFilterParams(filters: ActiveFilter[]): Partial<Record<string, string>> {
  const params: Record<string, string> = {}
  for (const filter of filters) {
    const param = MR_FILTER_PARAMS[filter.key as MrFilterKey]
    const value = filter.values[0]
    if (param && value) params[param] = value
  }
  return params
}

/**
 * Set one field's value, or clear it with `null`. A chip already on the bar
 * keeps its position so picking a second author swaps the value in place
 * instead of making the bar reshuffle under the cursor.
 */
export function setFilterValue(
  filters: ActiveFilter[],
  key: MrFilterKey,
  operator: FilterOperator,
  value: string | null,
): ActiveFilter[] {
  if (!value) return filters.filter((f) => f.key !== key)
  if (filters.some((f) => f.key === key)) {
    return filters.map((f) => (f.key === key ? { ...f, operator, values: [value] } : f))
  }
  return [...filters, { key, operator, values: [value] }]
}
