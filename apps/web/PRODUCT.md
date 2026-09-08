# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the author-curator.** One person, or a handful, keeping a rigorous
knowledge base about systems they are building — entities, use cases, contracts,
ERDs, processes. They write in long form, link deliberately, and care that the
links are true. Collaboration features (merge requests, review threads, activity)
exist because a document deserves the same review discipline as code, not because
a large team is present.

**Second, co-equal in intent: AI agents.** The MCP surface (`knowledge_*`) is a
first-class interface, not an export. An agent searching, ingesting, tracing
relations or asking for historical context is an expected user of the same store,
under the same workspace ACLs.

**Third, future: other teams.** The product is intended to ship beyond its author.
Nobody outside has used it yet, so first-run experience, setup, and legibility to a
stranger are known-unfinished rather than solved.

## Product Purpose

Hold documentation as a queryable, versioned, machine-readable structure instead of
a folder of files. A page is stored as immutable revisions on a branch DAG, chunked
and embedded, and projected into a graph of documents, entities and typed relations
with provenance. That combination makes three things possible that a wiki cannot do:
ask *what breaks if this changes*, review a documentation change the way a merge
request is reviewed, and let an agent traverse the same knowledge a person reads.

Success is that the knowledge base stays trustworthy as it grows: relations reflect
reality, a claim can be traced to the revision that introduced it, and stale pages
surface themselves rather than rotting quietly.

## Positioning

The combination is the position — each half exists elsewhere, the pair does not:

- **Graph and semantics in one query.** Search fuses vector similarity, optional
  BM25 and graph expansion; `impact-analysis` answers dependency questions across
  document→entity edges. This is not "search plus a diagram."
- **GitLab-shaped governance for prose.** Immutable revision DAG, branches, merge
  requests with structural *and* semantic diff, quote-anchored review threads,
  approval gates, `If-Match` concurrency. Documents are governed like code.
- **Agent-native by construction.** MCP is a constrained tool surface over the same
  ACLs, not raw DB access — the API and the agent interface cannot drift apart.
- **AI proposes, humans curate.** Relation extraction, glossary suggestion, review
  and ask-with-tools are authoring aids; deterministic facts (frontmatter, explicit,
  curated relations) always outrank inferred ones, and inference can never overwrite
  a curated edge.

All four are binding. Future work may not quietly drop one to simplify a surface.

## Operating Context

Containment is **Workspace > Project > Document**; the workspace is the tenant and
ACL boundary, the project is organizational. Documents nest into a tree and carry a
category (process, use case, contract, ERD…).

The daily loop:

1. Write or import a page (markdown, PDF, DOCX, PPTX, HTML, tabular, OCR).
2. Finalize a revision → it is chunked, embedded, indexed, and its relations
   extracted; dependents cascade one level of re-index.
3. Find things by hybrid search, the document tree, the graph, or the glossary.
4. Propose a change on a branch, open a merge request, annotate passages by quote,
   resolve threads, merge fast-forward.
5. Comment on live pages the same way — annotations outlive every revision.

Infrastructure runs locally via docker compose: PostgreSQL (transactional truth),
MinIO (raw bytes, versioned), ArcadeDB (graph + vectors), Redis/BullMQ (ingestion).
The API, an ingestion worker, an MCP server and an OpenAPI generator are four
entrypoints of one Nest app; the web app is Vue 3 with SSR.

## Capabilities & Constraints

**Shipped:** revision DAG + branches, compare (direct/merge-base, structural,
semantic), merge requests with gates/reviewers/threads, deterministic + inferred
relations with provenance, entity traversal and impact analysis, hybrid search with
graph expansion, MCP tools, auth (sessions, API keys, workspace RBAC, platform
admin), audited operator graph queries, stale detection and reindex scheduling,
historical fact queries, projects, glossary, page comments, document import,
AI settings (providers, skills, MCP plugins, budgets, usage), live updates over
SSE and WebSocket. A dynamic workflow layer (entity → use case → API/frontend) is
landing on the API and has no web surface yet.

**Deliberate constraints:**

- Merging is fast-forward-preconditioned; three-way content merge does not exist.
- The graph models semantic facts, never UI structure — there is no Project vertex.
- Documents are never rewritten by AI. Glossary linking, comment anchoring and
  relation inference are all read-time or additive; the stored markdown is the
  author's.
- Any graph read carries a mandatory workspace predicate; deny by default.

**Known gaps future work must not paper over:**

- **Internationalization is required and absent.** The interface must serve English
  and Russian; there is no i18n layer today and every string is inline English.
  Layouts must survive Cyrillic's longer strings.
- There is no test suite; verification is `make check` plus the end-to-end flow.
- First-run experience, empty states and setup guidance are unbuilt — the app
  assumes an operator who already knows the model.

## Brand Commitments

- **The name is undecided.** "Knowledge" is a working title inherited from the
  package namespace, the `<title>` tag and the demo workspace. Do not treat it as a
  brand, and do not invent a name, wordmark, tagline or logo.
- **Distribution is undecided** — self-hosted, hosted, or open core. No surface may
  assume one path (no hosted-only assumptions in the app shell, no self-host-only
  assumptions in onboarding).
- Existing identity artifacts are incumbent, not committed: `favicon.svg`, a Sora
  display face loaded from Google Fonts, and an OKLCH token palette described in
  `src/style.css` as "ink on paper, graph glow."
- Voice in the interface today is plain, technical and unhurried, with GitLab and
  Confluence as the vocabulary users are expected to already know.

## Evidence on Hand

Real and usable:

- `plan.md` — authoritative architecture document.
- `features.md` (Russian) — the original feature wishlist; 16 of 17 items shipped.
- `docs/features/01..16` — per-feature design records with scope, API surface and
  deliberate deferrals.
- `CLAUDE.md` — the working architecture record, kept current.
- A demo workspace id and a stub embedding provider that make a full end-to-end
  run possible with zero external dependencies.

Absent — future work must not fabricate these: no customers, users, testimonials,
case studies, press, benchmarks, pricing, licensing, uptime claims, or screenshots
of the product in real use. There is no public site, no logo, and no written
positioning copy.

## Product Principles

1. **Deterministic facts outrank inferred ones.** Frontmatter, explicit and curated
   relations are never overwritten by an LLM. Every fact carries its extractor and
   confidence, and the interface should show which kind it is looking at.
2. **Nothing is silently rewritten.** Glossary links, comment highlights and
   relation inference are projections over stored text, never edits to it. If an
   anchor cannot be resolved, it is reported outdated rather than re-anchored.
3. **A change to a document is a change worth reviewing.** Diff, discussion,
   approval and history are core, not power-user extras.
4. **The agent interface and the human interface are the same product.** A
   capability that exists for one and not the other is an unfinished capability.
5. **Trust degrades quietly, so make decay visible.** Stale revisions, drifted
   embedding models, unresolved threads and outdated anchors must surface in the
   UI rather than waiting to be discovered.

## Accessibility & Inclusion

WCAG 2.2 AA is the working target: contrast, focus order, full keyboard
reachability and honored `prefers-reduced-motion`. Recorded as a requirement future
work must not regress, not as a certification claim.

The reading and annotation surfaces carry the load — long-form prose, a rich-text
editor, quote-anchored highlights, a Cytoscape graph and a diff view all need
keyboard paths and non-color-only status encoding. The graph in particular must not
be the only route to any piece of information.
