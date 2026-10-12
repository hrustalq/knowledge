/**
 * A page as the editor holds it, and the source file it publishes.
 *
 * Lifted out of `EditorPage` because three things now need the same answer:
 * the save path (what is uploaded), the working copy (what is stored between
 * visits) and the unstaged-changes review (what the diff compares). A second
 * copy of `buildSource` in any of them would be a second opinion about what
 * publishing writes.
 */
import { normalizeEntityKey } from '@knowledge/contracts'

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
  /**
   * The template the page was started from (issue #69), sent as provenance
   * when it is created. Travels with the draft so a reload does not lose it,
   * and is not itself a change: it says where the page came from, not what
   * it says.
   */
  template?: TemplateProvenance | null
}

export interface TemplateProvenance {
  ref: string
  version: number
}

export function isTemplateProvenance(value: unknown): value is TemplateProvenance {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.ref === 'string' && typeof v.version === 'number'
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
  template: null,
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

/** What a template contributes to a page beyond its body. */
export interface TemplateDefaults {
  category: string
  relations: RelationRow[]
  /** Comma-separated, as `readFrontmatter` returns them. */
  tags: string
}

/**
 * A template's tags, relations and category laid over a page: tags and
 * relations are a union (a relation is the same one when its type and folded
 * key match), and the category is taken only while the page has none of its
 * own. Nothing the author already set is replaced.
 */
export function mergeTemplateDefaults<T extends Pick<PageFields, 'category' | 'relations' | 'tags'>>(
  page: T,
  defaults: TemplateDefaults,
): T {
  const tags = page.tags.split(',').map((t) => t.trim()).filter(Boolean)
  const seenTags = new Set(tags.map((t) => t.toLocaleLowerCase()))
  for (const tag of defaults.tags.split(',').map((t) => t.trim()).filter(Boolean)) {
    if (seenTags.has(tag.toLocaleLowerCase())) continue
    seenTags.add(tag.toLocaleLowerCase())
    tags.push(tag)
  }
  const relationId = (r: RelationRow) => `${r.type.trim().toUpperCase()}\u0000${normalizeEntityKey(r.key)}`
  const relations = page.relations.map((r) => ({ ...r }))
  const seenRelations = new Set(relations.filter((r) => r.key.trim()).map(relationId))
  for (const r of defaults.relations) {
    if (!r.key.trim() || seenRelations.has(relationId(r))) continue
    seenRelations.add(relationId(r))
    relations.push({ ...r })
  }
  return {
    ...page,
    category: page.category === 'other' ? defaults.category : page.category,
    relations,
    tags: tags.join(', '),
  }
}
