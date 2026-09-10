/**
 * Glossary terms inside the editor (docs/features/14, restored for 15).
 *
 * Feature 14 linked vocabulary by walking the rendered DOM, which worked while
 * the read view was `MarkdownView`. Feature 15 made the read view the editor
 * itself, and ProseMirror owns its DOM — markup injected from outside is
 * reconciled away — so that pass stopped reaching page content at all. This is
 * the same linking expressed the way ProseMirror expects, as inline decorations
 * over document positions: exactly the move `comment-anchors.ts` made, for
 * exactly the same reason.
 *
 * What does *not* change is the contract that matters: nothing is written to
 * the document. A page keeps the words its author wrote, and the glossary
 * decides on every render which of them are vocabulary — which is what makes a
 * definition editable in one place and retiring a term a one-row change.
 */
import { Decoration, Extension } from '@tiptap/core'
import type { GlossaryExclusion, GlossaryTerm } from '@knowledge/contracts'
import { findAnchor } from '@/lib/anchor-match'
import { projectDoc } from './comment-anchors'
import {
  GLOSSARY_AT_ATTR,
  GLOSSARY_ATTR,
  buildMatcher,
  glossaryHref,
  linkCap,
  spellingMatches,
} from '@/lib/glossary'

/**
 * Nodes whose text is not prose, or is already doing another job.
 *
 * The DOM pass spelled this as a selector (`a, code, pre, h1…h6, …`); these are
 * the same exclusions in the document's own vocabulary. Headings are titles,
 * not sentences — a definition link in one competes with the heading's job of
 * being scannable — and code is a literal, where a word that merely looks like
 * a term is not one.
 */
const SKIP_NODES = new Set(['heading', 'codeBlock', 'knMermaid', 'knDrawing', 'knFile', 'knToc'])

/** Marks that already claim the text: a link, or inline code. */
const SKIP_MARKS = new Set(['link', 'code'])

export interface GlossaryTermsStorage {
  terms: GlossaryTerm[]
  exclusions: GlossaryExclusion[]
}

declare module '@tiptap/core' {
  interface Storage {
    glossaryTerms: GlossaryTermsStorage
  }
  interface Commands<ReturnType> {
    glossaryTerms: {
      /** Replace the linked vocabulary and the exclusions, then redraw. */
      setGlossaryTerms: (terms: GlossaryTerm[], exclusions?: GlossaryExclusion[]) => ReturnType
    }
  }
}

export const GlossaryTerms = Extension.create<Record<string, never>, GlossaryTermsStorage>({
  name: 'glossaryTerms',

  addStorage() {
    return { terms: [], exclusions: [] }
  },

  addCommands() {
    return {
      setGlossaryTerms:
        (terms: GlossaryTerm[], exclusions: GlossaryExclusion[] = []) =>
        ({ editor, commands }) => {
          editor.storage.glossaryTerms.terms = terms
          editor.storage.glossaryTerms.exclusions = exclusions
          return commands.updateDecorations('glossaryTerms')
        },
    }
  },

  addDecorations() {
    return {
      // The vocabulary changes when someone edits the glossary, not when the
      // document changes, so redraws come from the command — same rationale as
      // the comment anchors next door.
      update: 'manual',
      create: ({ editor, state }) => {
        const matcher = buildMatcher(editor.storage.glossaryTerms.terms)
        const re = matcher?.re
        if (!re) return []

        /**
         * Excluded ranges, resolved once.
         *
         * The projection is O(document), so it is built a single time and every
         * exclusion is looked up in it — not one scan per exclusion. An
         * exclusion whose sentence is gone resolves to nothing and simply stops
         * applying, which is the right outcome: the words it was about are no
         * longer there to be mislinked.
         */
        const excluded: { from: number; to: number; termId: string }[] = []
        const stored = editor.storage.glossaryTerms.exclusions
        if (stored.length) {
          const projection = projectDoc(state.doc)
          for (const exclusion of stored) {
            const at = findAnchor(projection.text, exclusion.anchor)
            if (at < 0) continue
            const from = projection.positions[at]
            const last = projection.positions[at + exclusion.anchor.quote.trim().length - 1]
            if (from === undefined || last === undefined) continue
            excluded.push({ from, to: last + 1, termId: exclusion.termId })
          }
        }

        const decorations: Decoration[] = []
        /**
         * Occurrences linked per term, per page. A page where every instance of
         * a word is a link is a page nobody can read, so the rest keep the
         * plain word. The cap is the term's own when it sets one.
         *
         * No `title`: the definition is the hover card's job now, and a native
         * tooltip under it would be a second tooltip on the same word.
         */
        const used = new Map<string, number>()

        state.doc.descendants((node, pos, parent) => {
          if (!node.isText) {
            // Atoms hold no prose to link; anything else, keep descending.
            return !node.isAtom
          }
          if (parent && SKIP_NODES.has(parent.type.name)) return false
          if (node.marks.some((mark) => SKIP_MARKS.has(mark.type.name))) return false

          const text = node.text ?? ''
          re.lastIndex = 0
          for (let match = re.exec(text); match; match = re.exec(text)) {
            const spelling = match[1]
            if (!spelling) continue
            const candidate = matcher.byPattern.get(spelling.toLowerCase())
            if (!candidate) continue
            if (!spellingMatches(candidate, spelling)) continue
            const from = pos + match.index
            const to = from + spelling.length
            // Someone said this occurrence is not the term. Checked before the
            // cap, so excluding one mention does not silently cost the page one
            // of the three it is allowed.
            const isExcluded = excluded.some(
              (x) => x.termId === candidate.term.termId && from < x.to && to > x.from,
            )
            if (isExcluded) continue

            const count = used.get(candidate.term.termId) ?? 0
            if (count >= linkCap(candidate.term)) continue
            used.set(candidate.term.termId, count + 1)

            decorations.push(
              Decoration.Inline(from, to, {
                nodeName: 'a',
                class: 'kn-glossary',
                href: glossaryHref(candidate.term),
                [GLOSSARY_ATTR]: candidate.term.termId,
                // The exact characters this drew, so "not a term here" can
                // anchor on *this* occurrence. Searching for the word instead
                // finds the first one in the page, which for "Order" is the one
                // inside "OrderHub".
                [GLOSSARY_AT_ATTR]: String(from),
              }),
            )
          }
          return false
        })

        return decorations
      },
    }
  },
})
