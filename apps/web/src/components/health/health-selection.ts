/**
 * Multi-select over the knowledge-health table (docs/features/40, issue #66
 * phase 6), as a value rather than a component: the keyboard rules are what
 * make a two-hundred-row sweep bearable, and rules are testable only when they
 * live apart from the rows they act on.
 *
 * The rules are the ones every file manager has taught people's hands:
 *
 * - a click on a row's checkbox toggles that row and becomes the **anchor**;
 * - **shift** + click selects the whole range between the anchor and the row,
 *   adding to what is selected (never taking anything away), and leaves the
 *   anchor where it was so a second shift-click re-ranges from the same end;
 * - **cmd / ctrl** + click toggles the row without moving the anchor, so a
 *   range can be built and then pruned one row at a time;
 * - **Escape** clears everything.
 *
 * The selection is a set of ids, not of indexes: the rows under it change
 * (a filter switch, a refetch after a bulk action), and an index would then
 * name a different page. `prune` is what keeps the set honest when the rows
 * do — a page that scrolled out of the current list is still a page, so it
 * stays selected only while the list still shows it, otherwise a reader
 * would act on something they can no longer see.
 */

export interface HealthSelection {
  /** Selected document ids, in no particular order. */
  readonly ids: ReadonlySet<string>
  /** The row the next shift-click ranges from; `null` until the first plain click. */
  readonly anchor: string | null
}

export const EMPTY_SELECTION: HealthSelection = { ids: new Set(), anchor: null }

export interface SelectModifiers {
  shift?: boolean
  /** cmd on macOS, ctrl elsewhere — the caller reads whichever the platform uses. */
  meta?: boolean
}

/**
 * A click on `id`, with `order` being the ids of the rows as they are drawn,
 * top to bottom. Returns a new selection; the input is never mutated.
 */
export function selectRow(
  current: HealthSelection,
  id: string,
  order: readonly string[],
  modifiers: SelectModifiers = {},
): HealthSelection {
  if (modifiers.shift && current.anchor !== null) {
    const from = order.indexOf(current.anchor)
    const to = order.indexOf(id)
    // An anchor that is no longer drawn cannot bound a range; fall back to a
    // plain click rather than selecting nothing or everything.
    if (from === -1 || to === -1) return selectRow(current, id, order, {})
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    const ids = new Set(current.ids)
    for (const rowId of order.slice(lo, hi + 1)) ids.add(rowId)
    return { ids, anchor: current.anchor }
  }
  const ids = new Set(current.ids)
  if (ids.has(id)) ids.delete(id)
  else ids.add(id)
  return { ids, anchor: modifiers.meta ? current.anchor : id }
}

/** Select every drawn row, or — when every drawn row is already selected — none of them. */
export function toggleAll(current: HealthSelection, order: readonly string[]): HealthSelection {
  const all = order.length > 0 && order.every((id) => current.ids.has(id))
  if (all) return { ids: new Set(), anchor: null }
  return { ids: new Set([...current.ids, ...order]), anchor: current.anchor }
}

export function clearSelection(): HealthSelection {
  return EMPTY_SELECTION
}

/** Drop ids that are no longer drawn; the anchor goes with its row. */
export function prune(current: HealthSelection, order: readonly string[]): HealthSelection {
  const visible = new Set(order)
  const ids = new Set([...current.ids].filter((id) => visible.has(id)))
  if (ids.size === current.ids.size) return current
  return { ids, anchor: current.anchor !== null && visible.has(current.anchor) ? current.anchor : null }
}

/** What the header checkbox draws: all, some, or none of the drawn rows. */
export function headerState(current: HealthSelection, order: readonly string[]): 'all' | 'some' | 'none' {
  if (order.length === 0 || current.ids.size === 0) return 'none'
  let hit = 0
  for (const id of order) if (current.ids.has(id)) hit++
  if (hit === 0) return 'none'
  return hit === order.length ? 'all' : 'some'
}
