/**
 * A page as the editor holds it, and the source file it publishes.
 *
 * Lifted out of `EditorPage` because three things now need the same answer:
 * the save path (what is uploaded), the working copy (what is stored between
 * visits) and the unstaged-changes review (what the diff compares). A second
 * copy of `buildSource` in any of them would be a second opinion about what
 * publishing writes.
 */

export interface RelationRow {
  type: string
  key: string
  name: string
}

/** Everything on screen in the editor that publishing turns into a revision. */
export interface PageFields {
  title: string
  body: string
  category: string
  parentId: string
  projectId: string
  relations: RelationRow[]
  /** Comma-separated, exactly as typed. */
  tags: string
  /** The revision message. Travels with the draft; is not itself a change. */
  message: string
}

export const EMPTY_PAGE: PageFields = {
  title: '',
  body: '',
  category: 'other',
  parentId: '',
  projectId: '',
  relations: [],
  tags: '',
  message: '',
}

/** The frontmatter keys the settings sheet models. Everything else is carried verbatim. */
const MODELLED_KEYS = new Set(['relations', 'tags'])

/** Split parsed frontmatter into the rows the settings sheet edits and the keys it only carries. */
export function readFrontmatter(frontmatter: Record<string, unknown> | null | undefined): {
  relations: RelationRow[]
  tags: string
  other: Record<string, unknown>
} {
  const fm = frontmatter ?? {}
  const other = Object.fromEntries(Object.entries(fm).filter(([key]) => !MODELLED_KEYS.has(key)))
  const relations = Array.isArray(fm.relations)
    ? (fm.relations as Array<Record<string, unknown>>)
        .map((r): RelationRow | null => {
          const target = r.target
          if (typeof target === 'string') return { type: String(r.type ?? ''), key: target, name: '' }
          if (target && typeof target === 'object') {
            const t = target as Record<string, unknown>
            return { type: String(r.type ?? ''), key: String(t.key ?? ''), name: String(t.name ?? '') }
          }
          return null
        })
        .filter((r): r is RelationRow => r !== null && !!r.type && !!r.key)
    : []
  const tags = Array.isArray(fm.tags) ? (fm.tags as unknown[]).map(String).join(', ') : ''
  return { relations, tags, other }
}

/**
 * The markdown file a revision stores: frontmatter, then the body.
 *
 * Frontmatter `relations:`/`tags:` become graph edges via the deterministic
 * extractor (worker step 7). `other` is every key the editor does not model —
 * `source:` from a connector, `glossary: false` — re-emitted verbatim, because
 * rebuilding the block from the two fields on screen destroyed them on save.
 */
export function buildSource(
  page: Pick<PageFields, 'body' | 'relations' | 'tags'>,
  other: Record<string, unknown> = {},
): string {
  const rows = page.relations.filter((r) => r.type && r.key.trim())
  const tagList = page.tags.split(',').map((t) => t.trim()).filter(Boolean)
  const preserved = Object.entries(other).filter(([, v]) => v !== undefined)
  if (rows.length === 0 && tagList.length === 0 && preserved.length === 0) return page.body
  const lines: string[] = ['---']
  // JSON is valid YAML flow style, so anything gray-matter parsed round-trips
  // without this file needing a YAML emitter of its own.
  for (const [key, value] of preserved) lines.push(`${key}: ${JSON.stringify(value)}`)
  if (rows.length > 0) {
    lines.push('relations:')
    for (const r of rows) {
      const key = r.key.trim()
      const entityType = key.includes(':') ? key.slice(0, key.indexOf(':')) : 'entity'
      const name = r.name.trim() || key.split(':').pop() || key
      lines.push(`  - type: ${r.type}`)
      lines.push(`    target: { type: ${JSON.stringify(entityType)}, key: ${JSON.stringify(key)}, name: ${JSON.stringify(name)} }`)
    }
  }
  if (tagList.length > 0) {
    lines.push(`tags: [${tagList.map((t) => JSON.stringify(t)).join(', ')}]`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}${page.body}`
}

/**
 * Whether two states of a page would publish differently.
 *
 * Compares what a revision is made of, normalised the way `buildSource` will
 * normalise it: a blank relation row, a trailing comma in tags or a revision
 * message alone publish nothing, so none of them is a change.
 */
export function samePage(a: PageFields, b: PageFields): boolean {
  if (a === b) return true
  if (
    a.title.trim() !== b.title.trim() ||
    a.body !== b.body ||
    a.category !== b.category ||
    a.parentId !== b.parentId ||
    a.projectId !== b.projectId
  ) {
    return false
  }
  return buildSource({ ...a, body: '' }) === buildSource({ ...b, body: '' })
}
