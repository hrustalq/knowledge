import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitBranch, GitMerge, UserRound, UserRoundCheck, UserRoundPlus } from 'lucide-vue-next'
import type { ActiveFilter, FilterField, FilterOperator } from '@/components/ui/filter-bar'
import type { MergeRequestStatus, SavedFilterQuery } from '@knowledge/contracts'
import { useMembers } from './use-members'

/**
 * The filter bar's fields, mapped onto the `GET /v1/merge-requests` query params.
 *
 * Filtering happens on the server, not through `filterRows`: the list is
 * cursor-paginated, so narrowing only the loaded page would quietly disagree
 * with the tab counts and with "Load more". Every field here is therefore a
 * param the API actually serves — nothing else is offered.
 */
export const MR_FILTER_PARAMS = {
  author: 'authorId',
  assignee: 'assigneeId',
  reviewer: 'reviewerId',
  sourceBranch: 'sourceBranch',
  targetBranch: 'targetBranch',
} as const

export type MrFilterKey = keyof typeof MR_FILTER_PARAMS

/** The status tabs, in the order shown. 'all' applies no status filter. */
export const MR_STATES = ['open', 'merged', 'closed', 'all'] as const
export type MrState = (typeof MR_STATES)[number]

/**
 * People axes share the member roster; only the param they set differs. Labels
 * are message keys, not text: a module-scope map has no `t`, so the render site
 * resolves them (the same shape as NODE_STATUS_LABEL and the activity codes).
 */
export const MR_PEOPLE_FIELDS = [
  { key: 'author', label: 'filters.author', icon: UserRound, mine: 'filters.openedByMe' },
  { key: 'assignee', label: 'filters.assignee', icon: UserRoundPlus, mine: 'filters.assignedToMe' },
  { key: 'reviewer', label: 'filters.reviewer', icon: UserRoundCheck, mine: 'filters.reviewFromMe' },
] as const

/** Branches have no workspace-wide roster, so their value is typed, not picked. */
export const MR_BRANCH_FIELDS = [
  { key: 'sourceBranch', label: 'filters.sourceBranch', icon: GitBranch },
  { key: 'targetBranch', label: 'filters.targetBranch', icon: GitMerge },
] as const

/**
 * The field set, translated and populated with the member roster.
 *
 * Lifted out of the search bar because the saved-filter rail renders the same
 * chips as a readable manifest ("Reviewer / Alice"), and a second copy of these
 * definitions would be a second place for a new axis to be forgotten.
 */
export function useMrFilterFields(): {
  fields: ComputedRef<FilterField[]>
  fieldsByKey: ComputedRef<Map<string, FilterField>>
  /** Human label for one chip value — a member's name, or the typed text itself. */
  valueLabel: (key: string, value: string) => string
} {
  const { t } = useI18n()
  const { members } = useMembers()

  /** Role is the one thing that tells two same-named colleagues apart. */
  const memberOptions = computed(() =>
    members.value.map((m) => ({ value: m.userId, label: m.displayName, meta: m.role })),
  )

  // People are single-value `is`: the API takes one id per field and has no
  // negation, so offering "is not" or a second value would promise a query the
  // server cannot answer. A fixed operator renders as plain text, not a button.
  const fields = computed<FilterField[]>(() => [
    ...MR_PEOPLE_FIELDS.map((f) => ({
      key: f.key,
      label: t(f.label),
      icon: f.icon,
      options: memberOptions.value,
      multiple: false,
      operators: ['is'] as FilterOperator[],
    })),
    ...MR_BRANCH_FIELDS.map((f) => ({
      key: f.key,
      label: t(f.label),
      icon: f.icon,
      type: 'text' as const,
      // Substring, matching the server: "auth" should find "feature/auth".
      operators: ['contains'] as FilterOperator[],
      placeholder: 'feature/…',
    })),
  ])

  const fieldsByKey = computed(() => new Map(fields.value.map((f) => [f.key, f])))

  return {
    fields,
    fieldsByKey,
    valueLabel: (key, value) =>
      fieldsByKey.value.get(key)?.options?.find((o) => o.value === value)?.label ?? value,
  }
}

/**
 * Active chips as query params. The API takes one value per field and has no
 * negation, so fields are declared single-value `is` and an unfilled chip
 * contributes nothing — mid-build, it narrows everything rather than nothing.
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
 * keeps its position, so picking a second author swaps the value in place
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

// --- saved filters ---------------------------------------------------------
// A saved view and the page's live narrowing are the same three things; these
// functions are the only place that mapping lives.

/** The page's narrowing, in the shape the API stores. */
export function toSavedQuery(
  state: MrState,
  search: string,
  filters: ActiveFilter[],
): SavedFilterQuery {
  return {
    status: state,
    ...(search ? { search } : {}),
    // Unfilled chips are dropped: a half-built filter is not part of the view.
    chips: filters
      .filter((f) => f.values[0])
      .map((f) => ({ key: f.key, operator: f.operator, values: [...f.values] })),
  }
}

/** ...and back. Unknown keys are dropped rather than restored as dead chips. */
export function fromSavedQuery(query: SavedFilterQuery): {
  state: MrState
  search: string
  filters: ActiveFilter[]
} {
  const status = query.status as MergeRequestStatus | 'all' | undefined
  return {
    state: status && (MR_STATES as readonly string[]).includes(status) ? (status as MrState) : 'all',
    search: query.search ?? '',
    filters: (query.chips ?? [])
      .filter((c) => c.key in MR_FILTER_PARAMS && c.values[0])
      .map((c) => ({ key: c.key, operator: c.operator as FilterOperator, values: [...c.values] })),
  }
}

/**
 * Whether the live narrowing still matches a saved one. Drives "Update" vs
 * "Save as new", and the *modified* marker — so an applied view never silently
 * claims to be showing what it was saved as.
 */
export function sameQuery(a: SavedFilterQuery, b: SavedFilterQuery): boolean {
  const norm = (q: SavedFilterQuery): string =>
    JSON.stringify({
      status: q.status ?? 'all',
      search: q.search ?? '',
      chips: [...(q.chips ?? [])]
        .filter((c) => c.values[0])
        .sort((x, y) => x.key.localeCompare(y.key))
        .map((c) => [c.key, c.operator, [...c.values].sort()]),
    })
  return norm(a) === norm(b)
}
