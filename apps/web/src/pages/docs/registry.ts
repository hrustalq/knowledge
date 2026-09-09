/**
 * The documentation set: every article under `content/`, read once at module
 * load and shaped into a roster, a lookup and a search index.
 *
 * Bundled markdown rather than pages in the knowledge base itself, because
 * these docs describe the running build: they ship in the same commit as the
 * behaviour they describe, need no infrastructure to read, and cannot drift
 * per install. Search over them is a local filter — deliberately *not* the
 * product's own search, which answers about a workspace's content.
 *
 * `eager` is the point: the route is already lazy, so the whole set lands in
 * one chunk when someone opens the docs, and searching every body needs every
 * body anyway. Two dozen articles is a rounding error next to the editor.
 */
import { slugifyHeading } from '@/lib/markdown/render'

const RAW = import.meta.glob('./content/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

/** Generated tables an article can carry below its prose (see `widget:`). */
export type DocWidget = 'api-reference' | 'mcp-tools' | 'agent-skill'

export interface DocArticle {
  /** URL segment: `04-documents-revisions.md` → `documents-revisions`. */
  slug: string
  title: string
  section: string
  summary: string
  widget: DocWidget | null
  /**
   * The route this article documents, when it documents one. Structured rather
   * than written into the prose: the header can show it beside the title, and
   * an `# Editor — /create` heading under a header that already says "Editor"
   * makes the reader read the same words twice to find the one new word.
   */
  route: string | null
  /** Markdown body, frontmatter removed. */
  body: string
}

export interface DocSection {
  name: string
  articles: DocArticle[]
}

export interface DocHeading {
  text: string
  /** Anchor id, assigned exactly as MarkdownView will assign it. */
  id: string
  level: number
}

export interface DocMatch {
  article: DocArticle
  /** Occurrences in title + summary + body — the rail's relevance hint. */
  count: number
  /** Sections whose heading or content matched, as jump targets. */
  headings: DocHeading[]
  /** One line of body around the first hit, for the rail's preview. */
  excerpt: string | null
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * The frontmatter block, parsed by hand. gray-matter is an API-side dependency
 * and these files are ours: keys are `key: value` on one line, and anything
 * more elaborate belongs in the body.
 */
function parse(path: string, raw: string): DocArticle {
  const slug = path.replace(/^.*\/\d+-/, '').replace(/\.md$/, '')
  const match = raw.match(FRONTMATTER)
  const meta: Record<string, string> = {}

  if (match) {
    for (const line of match[1].split('\n')) {
      const pair = line.match(/^\s*(\w+):\s*(.*)$/)
      if (pair) meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '')
    }
  }

  const title = meta.title || slug
  return {
    slug,
    title,
    section: meta.section || 'Reference',
    summary: meta.summary || '',
    widget: (meta.widget as DocWidget) || null,
    route: meta.route || null,
    body: stripLeadingTitle(match ? raw.slice(match[0].length) : raw, title),
  }
}

/**
 * Drop the body's opening `# Heading` when it repeats the article's title.
 *
 * The page header already renders the canonical title, and every article
 * naturally opens with it — so without this the reader meets the same words
 * twice before the first sentence. A first heading that says something
 * different is a real section and stays. Same rule the document canvas applies
 * to a page's own markdown, for the same reason.
 */
function stripLeadingTitle(body: string, title: string): string {
  const text = body.replace(/^\s+/, '')
  const heading = text.match(/^#\s+(.+?)\s*\n/)
  if (!heading || heading[1].trim().toLowerCase() !== title.trim().toLowerCase()) return body
  return text.slice(heading[0].length).replace(/^\s+/, '')
}

/** Filename order (`01-…`, `02-…`) is authoring order, so it is reading order. */
export const articles: DocArticle[] = Object.entries(RAW)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, raw]) => parse(path, raw))

/** Sections in first-appearance order — the numeric prefixes group them. */
export const sections: DocSection[] = articles.reduce<DocSection[]>((acc, article) => {
  const existing = acc.find((s) => s.name === article.section)
  if (existing) existing.articles.push(article)
  else acc.push({ name: article.section, articles: [article] })
  return acc
}, [])

export function findArticle(slug: string | undefined): DocArticle | undefined {
  if (!slug) return articles[0]
  return articles.find((a) => a.slug === slug)
}

/**
 * Headings of one article, with the ids MarkdownView will render.
 *
 * Fenced code is skipped: a `# comment` inside a shell block is not a section,
 * and listing it as one produces a link to an anchor that never exists.
 */
export function headingsOf(article: DocArticle): DocHeading[] {
  const seen = new Map<string, number>()
  const headings: DocHeading[] = []
  let fenced = false

  for (const line of article.body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue

    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (!heading) continue

    const text = heading[2].replace(/[*_`]/g, '').trim()
    let id = slugifyHeading(text) || 'section'
    const count = seen.get(id) ?? 0
    seen.set(id, count + 1)
    if (count > 0) id = `${id}-${count}`

    headings.push({ text, id, level: heading[1].length })
  }
  return headings
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/**
 * Plain substring search across titles, summaries and bodies.
 *
 * No ranking model and no index: two dozen documents means the honest answer is
 * "which of these mention this word, and where" — and a fuzzy matcher would
 * mostly succeed at returning articles that do not contain the term at all.
 * Ordered by hit count so the article *about* the term outranks the ones that
 * mention it in passing.
 */
export function searchArticles(query: string): DocMatch[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const matches: DocMatch[] = []

  for (const article of articles) {
    const body = article.body.toLowerCase()
    const count =
      countOccurrences(article.title.toLowerCase(), needle) +
      countOccurrences(article.summary.toLowerCase(), needle) +
      countOccurrences(body, needle)
    if (count === 0) continue

    // A heading matches when it says the word, or when the prose under it does
    // — the second is what makes the sub-links useful, since the word a reader
    // searched for is usually in a paragraph rather than in a title.
    const headings = headingsOf(article)
    const hit = headings.filter((heading, i) => {
      if (heading.text.toLowerCase().includes(needle)) return true
      const start = article.body.indexOf(heading.text)
      const next = headings[i + 1] ? article.body.indexOf(headings[i + 1].text) : article.body.length
      return start !== -1 && body.slice(start, next).includes(needle)
    })

    matches.push({ article, count, headings: hit.slice(0, 4), excerpt: excerptAround(article.body, needle) })
  }

  return matches.sort((a, b) => b.count - a.count || a.article.title.localeCompare(b.article.title))
}

/** The line the first hit sits on, trimmed of markdown noise and clipped. */
function excerptAround(body: string, needle: string): string | null {
  const at = body.toLowerCase().indexOf(needle)
  if (at === -1) return null

  const start = body.lastIndexOf('\n', at) + 1
  const end = body.indexOf('\n', at)
  const line = body
    .slice(start, end === -1 ? body.length : end)
    .replace(/^[#>\-*\s|]+/, '')
    .replace(/[*_`]/g, '')
    .trim()

  if (line.length <= 120) return line || null
  // Keep the hit visible rather than the start of a long line.
  const offset = Math.max(0, at - start - 40)
  return `${offset > 0 ? '…' : ''}${line.slice(offset, offset + 120).trim()}…`
}
