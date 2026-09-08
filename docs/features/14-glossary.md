# 14 — Glossary

> Оригинал: «Референсные ссылки терминов на глоссарий (автоматическая
> подстановка с помощью ИИ)»

## What this is

A **project-level** vocabulary — term, aliases, definition, optionally the page
that defines it in full — and **automatic linking of those terms wherever they
appear**. Every rendered page matches its own text against the roster and turns
known terms into quiet dotted links carrying the definition; clicking one goes
to the defining page, or to the glossary entry.

The AI half is in the authoring, and it is reachable from both ends:

- **Settings → Glossary → Build the glossary from a page** — pick a page, get
  drafted entries, accept the ones you want.
- **Ask AI → Build glossary** — the same extraction over the page you are
  currently reading, with the proposals rendered in the chat transcript and an
  Add button on each.

Either way the model drafts term, aliases and a definition grounded in what the
page says, and a person accepts, edits or skips.

## Why

Every knowledge base accumulates words that mean something specific here and
something else everywhere else. Without a glossary they get re-explained in
each document that uses them, drift apart, and are invisible to the reader who
needed the definition most — the new one.

## Decisions

**Linking is deterministic and happens at read time; the AI is for
authoring.** This is the same split as frontmatter relations versus inferred
ones, and it is the important decision in the feature. Matching terms is
mechanical — a model adds nothing to it but latency, cost and nondeterminism —
whereas *noticing that a term needs defining, and drafting the definition* is
exactly what a model is good at. So `lib/glossary.ts` does the substitution on
every render with a regex, and the LLM is called once, by a human, from the
glossary page.

**Substitution never touches the stored markdown.** A page keeps the words its
author wrote; the glossary decides on each render which of them are
vocabulary. That is what makes a definition editable in one place — fix the
entry and every page follows on its next render — and what makes retiring a
term a one-row change instead of a mass edit. It also means the linker can be
conservative for free: it skips code, headings, existing links and review
annotations, and links at most the first three occurrences of a term per page,
because a page where every instance of a word is a link is unreadable.

**Word boundaries are spelled out, not `\b`.** The terms most in need of
defining are the ones `\b` breaks on — `.env`, `C++`, `@Access`. Both the
read-side linker and the server's occurrence counter use
`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, and the alternation is sorted
longest-first so "merge base" wins over "merge" when both are defined.

**A suggestion is a proposal, never a fact.** `POST /v1/glossary/suggest`
persists nothing. Proposals whose term does not literally appear in the source
are dropped, and the occurrence counts are computed here against the text
rather than taken from the model — "how often does this appear" is a fact
about the document, and models are bad at it. Accepted entries are stored with
`source: 'ai'` and badged as such in the UI, mirroring the `extractor`
provenance on graph edges.

**Vocabulary is scoped to the project, not the workspace.** The same word
routinely means different things in two bodies of work, and a glossary that
could not say so would be wrong in at least one of them. So `project_id` is
NOT NULL with a real FK and the uniqueness constraint is `(project_id, term)`
— two projects may define the same word and neither blocks the other. The
workspace stays the ACL boundary and `workspace_id` rides along denormalized,
exactly as on `documents`.

**A suggestion lands in the source page's project, not the caller's.** Terms
extracted from a page are vocabulary for that page's project;
`POST /v1/glossary/suggest` derives the project from the document and returns
it, so accepting a proposal cannot file it somewhere else.

**The roster is one lazily-loaded pinia store, and it follows the project
switcher.** Every rendered page wants it, so it must not become a request per
page; it is small, changes rarely, and is fetched on the first render that
asks. `rescope()` is called from the projects store next to the documents
store's — showing project A's definitions under project B's pages would be
worse than showing none. A failed load degrades to no links rather than to a
failed page: the prose is already on screen by then.

## Shape

- **DB** — `glossary_terms` (`workspace_id`, `project_id` FK, `term`,
  `aliases` Json, `definition`, `document_id`, `source`, `enabled`, audit
  columns), unique on `(project_id, term)`. No FK on `document_id`, mirroring
  `documents.parent_id`: deleting a page must not delete the vocabulary that
  referenced it, so the title is resolved at read time and a dangling link
  reads as an unlinked term. Migration `20260908120000_glossary_terms` —
  a new table, so no backfill.
- **Auth** — `WorkspaceSource` gains `'glossary-term'`; the ACL for
  `/:id` routes comes from the term's own row, so an editor of workspace A
  cannot rewrite the definitions workspace B's pages render.
- **API** — `GET /v1/glossary?workspaceId=&projectId=` (`viewer` — every
  reader needs the roster; an absent `projectId` spans the workspace, the same
  convention as `GET /v1/documents`), `POST` / `PATCH /:id` / `DELETE /:id`
  (`editor`, the same bar as editing the documents the vocabulary describes),
  and `POST /v1/glossary/suggest` (`viewer`; declared before `:id`, the same
  ordering rule as `GET /v1/documents/tree`). `suggest` follows the
  established assistant contract: it resolves the config through
  `resolveFor(workspaceId, 'review')` — extraction is an authoring pass, not a
  conversation — checks the token budget, and returns `enabled: false` rather
  than an error when the provider is `none`. `AiUsageOperation` gains
  `'glossary'`, so the spend shows up in Settings → AI → Usage like every other
  call. `GlossaryModule` is API-only (its controller needs the global guards).
- **Web** — `lib/glossary.ts` (the linker), `stores/glossary.ts` (the roster),
  a `glossary` prop on `MarkdownView` that runs the linker as its last pass
  (on for page content and review mode; off for comment bodies and assistant
  replies — vocabulary links belong in documentation, not in a chat log),
  `/settings/glossary` (`GlossaryPage.vue`), and the **Build glossary** quick
  action in `AskAssistant.vue`.
  The page is built from the app's existing controls rather than new ones:
  `FilterBar` scopes and narrows the roster (project is a **pinned** field —
  it decides what is fetched, not what is hidden, the same pattern as the
  workspace field on Access control), `Autocomplete` picks the source page and
  the defining page, and the definition is written in `RichEditor` in compact
  mode — the same editor a comment uses, so a definition can carry a code span
  or a link. Definitions are therefore markdown; the table renders them through
  `MarkdownView`, and the linker strips the markers for the `title` tooltip.

## Limits

- Aliases are literal spellings, not morphology: a Russian term needs its
  inflections listed as aliases, and there is no stemmer.
- The linker runs per render over the page's text nodes. That is fine for
  documentation-sized pages and a normal glossary; a roster in the thousands
  would want an index rather than one alternation.
- Terms are project-scoped with no inheritance: a word every project shares
  has to be defined in each. A workspace-wide tier (`project_id NULL` meaning
  "everywhere") is the obvious extension and is deliberately not built yet.
- Suggestions read one page at a time. There is no corpus-wide sweep yet.
