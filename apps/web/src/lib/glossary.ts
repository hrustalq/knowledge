/**
 * Read-side glossary linking (docs/features/14).
 *
 * The "automatic substitution" of the feature list happens here, at render
 * time, and never in the stored markdown. A page keeps the words its author
 * wrote; the glossary decides, on every render, which of them are vocabulary.
 * That is what makes a definition editable in one place — fix an entry and
 * every page that mentions the term follows on its next render — and what
 * makes retiring a term a one-row change instead of a mass edit.
 *
 * Matching is deterministic (whole-word, case-insensitive, longest term first)
 * and deliberately conservative: it never touches code, headings, existing
 * links, or text a reviewer has annotated, and it links only the first few
 * occurrences of a term, because a page where every instance of a word is a
 * link is a page nobody can read.
 */
import type { GlossaryTerm } from '@knowledge/contracts'
import { plainText } from './markdown/plain'

/** Occurrences linked per term, per page — the rest keep the plain word. */
const MAX_LINKS_PER_TERM = 3

/** Elements whose text is not prose, or is already doing another job. */
const SKIP_SELECTOR = 'a, code, pre, h1, h2, h3, h4, h5, h6, mark, .kn-file, .kn-toc, [data-kn-drawing], [data-kn-mermaid], [data-kn-glossary]'

export const GLOSSARY_ATTR = 'data-kn-glossary'

interface Candidate {
  term: GlossaryTerm
  /** The literal spelling matched — the alias, when an alias is what appeared. */
  pattern: string
}

function escapeRe(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One alternation over every spelling in the glossary, longest first so
 * "merge base" wins over "merge" where both are defined. Word boundaries are
 * spelled out as "not a letter or digit" rather than `\b`, which fails on the
 * terms that most need defining — `.env`, `C++`, `@Access`.
 */
function buildMatcher(terms: GlossaryTerm[]): { re: RegExp; byPattern: Map<string, Candidate> } | null {
  const byPattern = new Map<string, Candidate>()
  for (const term of terms) {
    if (!term.enabled) continue
    for (const pattern of [term.term, ...term.aliases]) {
      const key = pattern.trim().toLowerCase()
      if (!key || byPattern.has(key)) continue
      byPattern.set(key, { term, pattern })
    }
  }
  if (byPattern.size === 0) return null

  const alternation = [...byPattern.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|')
  return {
    re: new RegExp(`(?<![\\p{L}\\p{N}])(${alternation})(?![\\p{L}\\p{N}])`, 'giu'),
    byPattern,
  }
}

/**
 * Link glossary terms inside an already-rendered page.
 *
 * Returns the terms actually linked, so a caller can tell the reader what the
 * glossary contributed. Idempotent: a second pass over the same root finds its
 * own links already marked and skips them.
 */
export function linkGlossaryTerms(root: HTMLElement, terms: GlossaryTerm[]): GlossaryTerm[] {
  const matcher = buildMatcher(terms)
  if (!matcher) return []

  const used = new Map<string, number>()
  const linked = new Map<string, GlossaryTerm>()
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    if (!node.data.trim()) continue
    if (node.parentElement?.closest(SKIP_SELECTOR)) continue
    targets.push(node)
  }

  for (const node of targets) {
    matcher.re.lastIndex = 0
    const text = node.data
    if (!matcher.re.test(text)) continue
    matcher.re.lastIndex = 0

    const fragment = node.ownerDocument.createDocumentFragment()
    let cursor = 0
    for (let m = matcher.re.exec(text); m; m = matcher.re.exec(text)) {
      const candidate = matcher.byPattern.get(m[1]!.toLowerCase())
      if (!candidate) continue
      const count = used.get(candidate.term.termId) ?? 0
      if (count >= MAX_LINKS_PER_TERM) continue

      fragment.append(text.slice(cursor, m.index))
      fragment.append(buildLink(node.ownerDocument, candidate.term, m[1]!))
      cursor = m.index + m[1]!.length
      used.set(candidate.term.termId, count + 1)
      linked.set(candidate.term.termId, candidate.term)
    }
    if (cursor === 0) continue
    fragment.append(text.slice(cursor))
    node.replaceWith(fragment)
  }
  return [...linked.values()]
}

/**
 * The link itself. It goes to the page that defines the term when there is
 * one and to the glossary otherwise, and it carries the definition in a
 * `title` — the hover card upgrades that, but a definition a reader can see
 * without JavaScript is the floor, not the ceiling.
 */
function buildLink(doc: Document, term: GlossaryTerm, label: string): HTMLElement {
  const el = doc.createElement('a')
  el.setAttribute(GLOSSARY_ATTR, term.termId)
  el.className = 'kn-glossary'
  el.href = term.documentId ? `/documents/${term.documentId}` : `/settings/glossary?term=${term.termId}`
  el.title = `${term.term} — ${plainText(term.definition)}`
  el.textContent = label
  return el
}

/** Strip every link this module made (used before re-linking after an edit). */
export function clearGlossaryLinks(root: HTMLElement): void {
  for (const link of [...root.querySelectorAll<HTMLElement>(`a[${GLOSSARY_ATTR}]`)]) {
    link.replaceWith(...link.childNodes)
  }
  root.normalize()
}
