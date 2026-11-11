import type { ActiveFilter } from './types'

/**
 * How a row answers one field. Return a string, a list (a row that carries
 * several values, e.g. workspace roles), a boolean, or null for "absent".
 */
export type FilterAccessors<T> = Record<string, (row: T) => unknown>

function toStrings(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (typeof value === 'boolean') return [value ? 'true' : 'false']
  return [String(value)]
}

/** True when `row` satisfies every filter (filters are ANDed, values ORed). */
export function matchesFilters<T>(
  row: T,
  filters: ActiveFilter[],
  accessors: FilterAccessors<T>,
): boolean {
  return filters.every((filter) => {
    const accessor = accessors[filter.key]
    // An unknown field or an unfilled chip narrows nothing — the user is
    // mid-build, and dropping every row would look like a bug.
    if (!accessor) return true
    const wanted = filter.values.filter((v) => v !== '')
    if (wanted.length === 0) return true

    const actual = toStrings(accessor(row))
    switch (filter.operator) {
      case 'is':
        return wanted.some((v) => actual.includes(v))
      case 'is-not':
        return !wanted.some((v) => actual.includes(v))
      case 'contains':
        return actual.some((a) => a.toLowerCase().includes(wanted[0].toLowerCase()))
      case 'not-contains':
        return !actual.some((a) => a.toLowerCase().includes(wanted[0].toLowerCase()))
    }
  })
}

export function filterRows<T>(
  rows: T[],
  filters: ActiveFilter[],
  accessors: FilterAccessors<T>,
): T[] {
  if (filters.length === 0) return rows
  return rows.filter((row) => matchesFilters(row, filters, accessors))
}
