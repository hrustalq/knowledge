/**
 * An API block section's table, read for display (#78).
 *
 * The table is the author's content — its headers were written in whatever
 * language the page was authored in, and stay that way in the stored markdown
 * (document content is never translated, docs/features/18). Reading, the card
 * shows the *meaning* of each column in the reader's language instead: every
 * header is recognised as a role (name, location, type, required…) in either
 * language, or by its position in the template when it is not, and the view
 * labels the role through i18n. A column nobody recognises is kept, under its
 * own header, so nothing the author wrote disappears.
 */

export type ApiSectionKind = 'params' | 'body' | 'responses' | 'auth'
export type ColumnRole = 'name' | 'in' | 'type' | 'required' | 'description' | 'code' | 'body'

/** Header spellings per role: the template's own (en + ru, `api.col.*`) and the obvious variants. */
const ROLE_WORDS: Record<ColumnRole, readonly string[]> = {
  name: ['name', 'field', 'header', 'parameter', 'param', 'property', 'имя', 'поле', 'заголовок', 'параметр', 'название', 'свойство'],
  in: ['in', 'location', 'where', 'где', 'расположение', 'место'],
  type: ['type', 'schema', 'format', 'тип', 'схема', 'формат'],
  required: ['required', 'req', 'mandatory', 'обяз', 'обязательно', 'обязательный', 'обязательное'],
  description: ['description', 'desc', 'notes', 'comment', 'описание', 'комментарий', 'примечание'],
  code: ['code', 'status', 'код', 'статус'],
  body: ['body', 'response', 'payload', 'тело', 'ответ'],
}

/** The template's column order per section — the fallback for a header nobody recognises. */
const TEMPLATE_ORDER: Record<ApiSectionKind, readonly ColumnRole[]> = {
  params: ['name', 'in', 'type', 'required', 'description'],
  body: ['name', 'type', 'required', 'description'],
  responses: ['code', 'body', 'description'],
  auth: ['name', 'required', 'description'],
}

export function isApiSectionKind(kind: string): kind is ApiSectionKind {
  return kind in TEMPLATE_ORDER
}

const fold = (s: string) => s.normalize('NFC').trim().toLowerCase().replace(/[.:*]+$/u, '').trim()

function roleOf(header: string): ColumnRole | null {
  const h = fold(header)
  if (!h) return null
  for (const [role, words] of Object.entries(ROLE_WORDS) as Array<[ColumnRole, readonly string[]]>) {
    if (words.includes(h)) return role
  }
  return null
}

const YES = /^(yes|y|true|required|да|обязательно|обязательный|✓|✔|\+|x)$/iu
const NO = /^(no|n|false|optional|нет|необязательно|опционально|-|—|–)$/iu

/** `yes` / `да` / `✓` → true, `no` / `нет` / `-` → false; anything else is the author's own word. */
export function requiredValue(raw: string): boolean | null {
  const v = raw.trim()
  if (YES.test(v)) return true
  if (NO.test(v)) return false
  return null
}

/** `path` / `путь` → `path`, for the short location label; null when it is something else. */
export function locationOf(raw: string): 'path' | 'query' | 'header' | 'cookie' | 'body' | null {
  const v = fold(raw)
  if (['path', 'путь'].includes(v)) return 'path'
  if (['query', 'запрос', 'строка запроса'].includes(v)) return 'query'
  if (['header', 'headers', 'заголовок', 'заголовки'].includes(v)) return 'header'
  if (['cookie', 'cookies', 'куки'].includes(v)) return 'cookie'
  if (['body', 'тело'].includes(v)) return 'body'
  return null
}

export interface ApiBlockRow {
  name: string
  in: string
  type: string
  /** Raw cell; read it through `requiredValue`. */
  required: string
  description: string
  code: string
  body: string
  /** Columns no role matched, under the author's header. */
  extras: Array<{ label: string; value: string }>
}

/**
 * Rows of one section's table, columns resolved to roles. A row with no text
 * in any cell (the template's blank placeholder row) is dropped.
 */
export function readApiBlockRows(kind: ApiSectionKind, headers: string[], rows: string[][]): ApiBlockRow[] {
  const taken = new Set<ColumnRole>()
  const roles: Array<ColumnRole | null> = headers.map((h) => {
    const role = roleOf(h)
    if (role && !taken.has(role)) {
      taken.add(role)
      return role
    }
    return null
  })
  // Unrecognised headers fall back to the template's column at that position,
  // when that role is still free — a page authored in a third language.
  roles.forEach((role, i) => {
    const fallback = TEMPLATE_ORDER[kind][i]
    if (!role && fallback && !taken.has(fallback) && !roleOf(headers[i] ?? '')) {
      taken.add(fallback)
      roles[i] = fallback
    }
  })

  const out: ApiBlockRow[] = []
  for (const cells of rows) {
    if (!cells.some((c) => c.trim())) continue
    const row: ApiBlockRow = { name: '', in: '', type: '', required: '', description: '', code: '', body: '', extras: [] }
    cells.forEach((raw, i) => {
      const value = raw.trim()
      const role = roles[i]
      if (role) row[role] = value
      else if (value) row.extras.push({ label: headers[i]?.trim() || `#${i + 1}`, value })
    })
    out.push(row)
  }
  return out
}
