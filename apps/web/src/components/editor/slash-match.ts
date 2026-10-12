/**
 * What `/` matches in the editor's command menu: the typed text against an
 * item's label, keywords and group, case-insensitively.
 *
 * Lifted out of `RichEditor` so the vocabulary it is matched against can be
 * pinned by a test. Labels are translated but keywords are not, so an item
 * that should answer to a Russian word has to carry it here — without one, a
 * Russian-locale author typing `/шаблон` would get an empty menu.
 */
export interface SlashMatchable {
  label: string
  keywords?: string
  group: string
}

export function slashItemMatches(item: SlashMatchable, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${item.label} ${item.keywords ?? ''} ${item.group}`.toLowerCase().includes(needle)
}

/** `/template` (issue #69): the kinds of page the built-ins cover, in both languages. */
export const TEMPLATE_SLASH_KEYWORDS =
  'template skeleton structure adr rfc runbook postmortem шаблон структура заготовка'
