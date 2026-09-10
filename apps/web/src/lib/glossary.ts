/**
 * Read-side glossary matching (docs/features/14).
 *
 * The "automatic substitution" of the feature list happens at render time and
 * never in the stored markdown. A page keeps the words its author
 * wrote; the glossary decides, on every render, which of them are vocabulary.
 * That is what makes a definition editable in one place — fix an entry and
 * every page that mentions the term follows on its next render — and what
 * makes retiring a term a one-row change instead of a mass edit.
 *
 * Matching is deterministic (whole-word, longest term first) and deliberately
 * conservative: it links only the first few occurrences of a term, because a
 * page where every instance of a word is a link is a page nobody can read.
 *
 * This module is the matcher only. Drawing the links is the caller's job —
 * today that is one caller, `components/editor/extensions/glossary-terms.ts`,
 * which draws them as ProseMirror decorations because the read view *is* the
 * editor since docs/features/15. The DOM-walking pass this file used to carry
 * was deleted with the `MarkdownView` prop that was its only entry point.
 */
import {
  GLOSSARY_BOUNDARY_AFTER,
  GLOSSARY_BOUNDARY_BEFORE,
  type GlossaryTerm,
} from '@knowledge/contracts'
import { plainText } from './markdown/plain'

/** Occurrences linked per term, per page — the rest keep the plain word. */
export const MAX_LINKS_PER_TERM = 3

/** The term's own cap when it sets one, else the shared default. */
export function linkCap(term: GlossaryTerm): number {
  return term.maxLinksPerPage ?? MAX_LINKS_PER_TERM
}

/**
 * Whether a matched spelling counts, given the entry's casing rule.
 *
 * The alternation stays case-insensitive and this is checked per match, so a
 * case-sensitive term costs one string comparison rather than a second regex
 * and a merge pass over two result sets.
 */
export function spellingMatches(candidate: Candidate, matched: string): boolean {
  return !candidate.term.caseSensitive || candidate.pattern === matched
}

export const GLOSSARY_ATTR = 'data-kn-glossary'
/** The document position a decoration starts at, for anchoring an exclusion. */
export const GLOSSARY_AT_ATTR = 'data-kn-glossary-at'

export interface Candidate {
  term: GlossaryTerm
  /** The literal spelling matched — the alias, when an alias is what appeared. */
  pattern: string
  /** This spelling IS the entry's term, not one of its aliases. */
  headword: boolean
}

/** A spelling two entries claim, which therefore links to neither. */
export interface AmbiguousSpelling {
  spelling: string
  terms: GlossaryTerm[]
}

export interface Matcher {
  /** null when no spelling survived; `ambiguous` says why. */
  re: RegExp | null
  byPattern: Map<string, Candidate>
  ambiguous: AmbiguousSpelling[]
}

function escapeRe(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One alternation over every spelling in the glossary, longest first so
 * "merge base" wins over "merge" where both are defined. The boundaries come
 * from contracts because the API's occurrence counter has to agree with them.
 */
export function buildMatcher(terms: GlossaryTerm[]): Matcher | null {
  const claims = new Map<string, Candidate[]>()
  for (const term of terms) {
    if (!term.enabled) continue
    // `matchAliases: false` is the escape hatch for an alias that is also an
    // ordinary word: the entry keeps its aliases (they are still what someone
    // searches by) but only the headword is linked in prose.
    const spellings = term.matchAliases ? [term.term, ...term.aliases] : [term.term]
    for (const pattern of spellings) {
      const key = pattern.trim().toLowerCase()
      if (!key) continue
      const headword = term.term.trim().toLowerCase() === key
      const bucket = claims.get(key)
      if (bucket) bucket.push({ term, pattern, headword })
      else claims.set(key, [{ term, pattern, headword }])
    }
  }

  const byPattern = new Map<string, Candidate>()
  const ambiguous: AmbiguousSpelling[] = []
  for (const [key, bucket] of claims) {
    const winner = resolveClaim(bucket)
    if (winner) byPattern.set(key, winner)
    else ambiguous.push({ spelling: bucket[0]!.pattern, terms: bucket.map((c) => c.term) })
  }
  if (byPattern.size === 0) return { re: null, byPattern, ambiguous }

  const alternation = [...byPattern.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|')
  return {
    re: new RegExp(`${GLOSSARY_BOUNDARY_BEFORE}(${alternation})${GLOSSARY_BOUNDARY_AFTER}`, 'giu'),
    byPattern,
    ambiguous,
  }
}

/**
 * Which entry owns a spelling when several claim it.
 *
 * An exact headword beats an alias: an entry *called* "Order" is a better
 * answer for the word "Order" than an entry that merely lists it. Two headwords
 * or two aliases and the spelling links to **neither** — with nothing but the
 * word to go on there is no way to tell which was meant, and sending a reader
 * to a plausible wrong definition is worse than leaving the word plain. Same
 * rule, same reason, as the page-title resolver in `lib/page-refs.ts`.
 */
function resolveClaim(bucket: Candidate[]): Candidate | null {
  if (bucket.length === 1) return bucket[0]!
  const headwords = bucket.filter((c) => c.headword)
  return headwords.length === 1 ? headwords[0]! : null
}

/**
 * Where a term sends the reader: the page that defines it when there is one,
 * the glossary entry otherwise.
 */
export function glossaryHref(term: GlossaryTerm): string {
  return term.documentId ? `/documents/${term.documentId}` : `/settings/glossary?term=${term.termId}`
}

/**
 * The definition, as a `title`. A hover card upgrades this, but a definition a
 * reader can see without JavaScript is the floor, not the ceiling.
 */
export function glossaryTitle(term: GlossaryTerm): string {
  return `${term.term} — ${plainText(term.definition)}`
}
