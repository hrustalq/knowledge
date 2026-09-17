# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with two additions this project needs — **Breaking** and **Operations** — and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
narrowed in [docs/versioning.md](docs/versioning.md).

`[Unreleased]` is work merged to `dev` that is **built, tested and not serving
traffic**. A release promotes it to `main`; production moves only when a `vX.Y.Z`
tag is pushed. Entries are written
in the pull request that introduces them — see
[docs/templates/changelog-entry.md](docs/templates/changelog-entry.md).

## [Unreleased]

### Fixed

- **Russian headings have stable anchors again.** Every Cyrillic heading used to
  slugify to nothing, so a Russian page's section links were `section`, `-1`,
  `-2` — and retargeted whenever a heading was inserted above. Anchors are now
  built from the heading text in any script. Existing deep links into Russian
  sections change once.
- **Russian PDFs no longer keep hyphenation breaks.** A word split across lines
  in a justified Russian PDF («информа-ция») was imported as two fragments and
  was unfindable; it is now rejoined the way Latin text already was.
- **AI skill triggers written in Russian match whole words.** A trigger like
  «релиз» fired inside «релизный»; the boundary test is now Unicode-aware.
- **Auto-started workflow runs and scheduled agent runs are written in the
  owner's language.** Both defaulted to English regardless of the workspace,
  so an auto-triggered chain in a Russian workspace generated English pages and
  the nightly curator reported in English. Manually started runs were unaffected.
- **Glossary suggestions on a page in another language are no longer dropped.**
  The glossarist was told to write in the page's language and, a line later, in
  the reader's; when it translated the term, the verbatim-occurrence check
  discarded every suggestion in silence. Terms are now always copied from the
  page verbatim; the definition follows the reader's language.
- **Reviewer and glossarist run summaries, warnings and the "assistant
  disabled" reply are translated.** They were hardcoded English, and the
  disabled reply was persisted into the chat thread that way.
- **Russian counts above 100 are declined correctly.** 111 and 212 read as
  «111 страница» / «212 страницы»; the plural rule now looks at the last two
  digits.
- **Review severity badges show a translated label** instead of the raw
  `error` / `warning` / `suggestion` value.
### Added

- `docs/architecture/` — nine per-layer implementation documents for the machinery
  that belongs to no single feature: entrypoints and module boundaries, persistence
  and revisions, ingestion, search and graph, merge and review, auth and ACLs, the
  generated client and error contract, events and live updates, and the web
  frontend. Where the code has diverged from `plan.md` they say so, rather than
  letting the design document quietly stop being true.
- `docs/features/27-comment-editing.md`, documenting comment editing and the
  Comment vs. Start thread split, which had shipped undocumented — its only record
  was a bullet in `CLAUDE.md`.

### Changed

- **`CLAUDE.md` carries conventions and gotchas only**, as `CONTRIBUTING.md`
  already said it did. The 27 per-feature implementation narratives moved into
  `docs/features/` and the new `docs/architecture/` layer, leaving a pointer table;
  the cross-cutting rules that were buried inside them are collected under a new
  **Conventions** section. Several claims were corrected against the code on the
  way out: the glossary word boundary, a `MarkdownView` glossary prop that no
  longer exists, comment reply nesting, the connector table count, and the
  built-in agent roster.
- `docs/README.md` indexes all 27 feature docs and the architecture set; it
  previously stopped at 17 and listed feature 16 as undocumented although its doc
  was sitting next to it.

## [0.6.0] — 2026-09-16

### Added

- **A background agent run says what it is doing while it does it.** A running
  agent now shows the step it is on and how far in it is, and lists anything that
  degraded without failing the run — a page it could not read, a graph store that
  was down — instead of showing nothing until it finished. The list refreshes on
  its own while work is in flight.
- **A finding can cite a page on the web.** Until now a finding that named no
  page in the workspace was discarded, so anything grounded off-platform was
  thrown away in silence. Web citations render as the same chips the assistant
  cites with, and carry through to the draft when you propose a fix.

### Fixed

- **A long agent run is no longer run twice.** Any run still going after half an
  hour was presumed dead and started again, paying for a second set of model
  calls — and whichever copy finished last overwrote the other's result. Runs now
  report as they go, so a slow one is not mistaken for a dead one, and a run that
  has been superseded discards its own result rather than overwriting the run
  that replaced it.
- **The published API description declares the right version** (it said `0.2.0`),
  along with a tool-budget limit that had moved without the description being
  regenerated.

### Changed

- **The assistant fetches several sources at once.** When a turn asks for several
  searches or web pages in one round, they are retrieved together rather than one
  after another, which is where turns that read a lot of the web spent most of
  their time. Actions that change something still run one at a time, so Stop
  continues to stop before anything is created.

### Operations

- One migration (`20260916103000_agent_run_progress`) adds three nullable columns
  to `agent_runs`. Additive only, and runnable by the previous release's image —
  no expand/contract sequencing needed.

## [0.5.0] — 2026-09-16

### Added

- **A shared page layout.** Every screen except the sign-in cards is now one of
  four shapes — something you read, a list, a subject with a rail of facts
  beside it, or a surface that owns the window — so the title, the controls and
  the state of a page sit in the same place on all of them. (#17)
- **Tab strips answer to the keyboard.** Arrow keys move between tabs, `Home`
  and `End` jump to the ends, the strip takes one tab stop instead of one per
  tab, and each tab names the panel it controls for a screen reader. Five pages
  had hand-written strips and none of them did any of this. (#17)
- **A page's rail remembers what you keep open.** Opening History or Changes on
  one page leaves it open on the next for the rest of the session, rather than
  collapsing back to Overview every time you open a page. (#17)
- **The assistant can read PDFs it finds on the web.** A link to a standard, a
  whitepaper or a spec used to be refused outright — the one format a research
  question lands on most. Headings are reconstructed from font size, the same
  way an imported PDF's are, and a scanned PDF now says it is scanned rather
  than arriving as a document that appears to say nothing. (#18)
- **Web citations carry an author and a publication date** where the page
  declares them, so an answer can say how old a source is instead of only where
  it lives. (#18)

### Changed

- **A column that fills the window now measures the header above it instead of
  assuming it.** Side rails subtracted a fixed topbar-plus-breadcrumb height,
  but the breadcrumb strip only appears on screens that have a trail. Every
  screen using it happened to have one, so nothing looked wrong — the next one
  would have run 36px past the bottom of the window with nothing in the code to
  explain why. (#17)
- **Page titles are one size.** Workflows and the pages index showed their
  titles smaller than a settings subpage; sixteen heading styles are now one. (#17)
- **Empty, loading, failed and no-access states share one anatomy** instead of
  eight hand-built variants, and being unable to edit something now reads as a
  statement about your role rather than as an error. (#17)
- **A fetched web page is now scored for its article rather than stripped by tag
  name.** Sidebars, related-article rails, comment sections and cookie-notice
  remnants reached the assistant as though they were the page, because none of
  them sits inside `nav`, `header`, `footer` or `aside`. A page that yields
  almost nothing now says so, instead of being answered from confidently. (#18)

## [0.4.0] — 2026-09-16

### Added

- **The background agents can now read while they work.** The four read-only
  tools — `search_knowledge`, `read_document`, `explore_document_graph` and the
  new `list_relations` — moved into a service the worker can load, so the curator
  opens pages before judging them. It used to decide whether two pages duplicated
  or contradicted each other from a listing of ids, titles and dates, which
  cannot answer that question: "Deploys" and "Release process" are either the
  same page written twice or two different pages, and only their contents say
  which. A model without tool support still runs the previous single-shot pass
  rather than being skipped entirely.
- `list_relations`, a fourth read-only tool, listing a page's relations.

### Changed

- **The assistant's tool budget now defaults to 24 calls per question, up from
  6**, and its ceiling rises from 16 to 64. Six was spent by a single real
  question on search → read ×2 → explore → `list_relations`, after which the
  model had to answer from half the evidence it had asked for. **This increases
  model spend per question**; set `ASSISTANT_MAX_TOOL_CALLS=6` to keep the
  previous behaviour.

### Fixed

- Pasting a long page, writing a long comment or submitting a large import no
  longer fails with an untranslated 500. Request bodies were silently capped at
  Express's 100 kB default; the cap is now configurable, starts at 2 MB, and an
  oversize body comes back as a translated error instead of a crash inside the
  body parser.

### Operations

- New env var **`HTTP_BODY_LIMIT`** (default `2mb`) caps JSON and urlencoded
  request bodies. It has a default, so no action is required to deploy — set it
  only to raise or lower the cap. It counts **bytes, not characters** (Cyrillic
  is two bytes each), so keep it comfortably above the per-field length limits.
- `ASSISTANT_MAX_TOOL_CALLS` changes default from 6 to 24. An install that never
  set it explicitly will spend more per assistant question after this release.

## [0.3.0] — 2026-09-16

### Added

- **Documentation can be derived from a codebase.** A new `codebase` connector
  points at a GitHub or GitLab repository and produces an overview page plus one
  page per module, read from the source rather than mirrored from prose that
  already exists. Module structure comes from the repository's manifests, and
  each page's API surface — exported symbols and their signatures — is extracted
  with tree-sitter. The written summary that opens a page comes from the
  workspace's `author` agent and is optional: with no AI provider configured, no
  owner to bill or no budget left, the pages still arrive with the extracted
  facts and a warning saying which. Re-syncing a repository whose source has not
  changed makes no AI calls at all.

### Fixed

- Connectors, AI plugins and web research could reach no external host at all on
  Node 24 and Node 25, reporting `could not reach <url>` for every request. The
  guarded HTTP client drove a dispatcher from this repository's `undici` with the
  `fetch` built into Node, and those two only interoperate when the running Node
  happens to bundle a matching `undici` generation.

## [0.2.0] — 2026-09-15

### Breaking

- `PATCH /v1/workflows/runs/:id/nodes/:nodeId` now validates `draft.relations`
  element by element: each entry needs a `type` from the relation allowlist and a
  `target.key`. `HTTP`
  **Migration:** send each entry as
  `{ "type": "IMPLEMENTS", "target": { "type": "service", "key": "service:identity" } }`,
  or omit `relations` entirely. The field previously accepted any array and was
  ignored by every executor, so a client that never sent it is unaffected.

### Added

- **The assistant can maintain a page's relations.** Ask it to connect or
  disconnect two pages and it edits the page's own frontmatter and opens a merge
  request — it never changes a live page. Only `relations:` and `tags:` are
  touched; every other frontmatter key is carried through untouched.
- **Cartographer**, a background agent that proposes the relations a page should
  declare. It reports connections a model inferred from a page's text that the
  page itself never declared — the lowest-trust class there is, replaced on every
  re-index — alongside gaps the pages support but nothing has recorded.
- Findings about missing relations can now be acted on at all. An orphan finding
  could previously only be read: "propose a fix" refused it, because the fix is a
  relation rather than page text. Such findings now carry the relations they
  propose, and **Apply relations** turns one into a merge request.
- Workflow steps propose relations and tags for the pages they draft, and the
  review panel shows them — so a generated page's connections are read before
  they are approved rather than discovered afterwards.

### Fixed

- **Editing a page no longer destroys its frontmatter.** Saving in the rich
  editor rebuilt the block from `relations:` and `tags:` alone and silently
  discarded every other key — including `source:`, written by every connector
  adapter, and `glossary: false`, which turns term linking off for a page. This
  affected both creating and editing a page.
- Workflow-generated pages no longer lose the frontmatter their step produced.
  If the drafted body already began with `---`, the whole block was dropped.
- The workflow canvas offers every relation type the graph accepts. It listed
  five of eight, and a chain naming one of the other three was silently rewritten
  to `IMPLEMENTS`. An unrecognised type is now refused in the editor, where it can
  still be corrected, instead of failing when the page is finally published.

### Changed

- A relation change shows some incidental reformatting of neighbouring
  frontmatter keys in its merge-request diff — rewriting the block re-serializes
  all of it. Keys and values are unchanged; comments and quoting style are not
  preserved. The merge request says so.

## [0.1.0] — 2026-09-15

### Added

- Versioning policy, changelog, contribution rules and a tag-triggered release
  flow (`docs/versioning.md`, `CONTRIBUTING.md`, this file).
- Conventional Commits enforced on every commit by a `commit-msg` hook.

### Changed

- **`main` no longer deploys.** `deploy.yml` triggers on `v*.*.*` tags instead of
  on push, so merging integrates and tagging releases.
- Images are now tagged with the release version alongside the commit SHA, making
  a rollback `docker tag knowledge-api:vX.Y.Z knowledge-api:latest` + `compose up -d`.

### Fixed

- **Merge requests no longer deadlock.** Every `POST /v1/merge-requests/:id/merge`
  hung until its connection died, and each retry wedged another pair of connections
  until the pool starved and the API had to be replaced. A raw `$transaction` inside
  an open `withTransaction` boundary does not join it — it opens a second
  transaction on a second pooled connection — so creating the merge revision (whose
  foreign key needs a `KEY SHARE` lock) and advancing the branch head both waited on
  a `document_branches` row the outer connection held `FOR UPDATE`. Postgres saw the
  outer session as `idle in transaction` rather than blocked, so its deadlock
  detector never fired. The same change stops document import and connector staging
  from committing inner work when their outer boundary rolls back. (#7)
- Documents no longer fail to index on a newly deployed instance. Every upload
  stayed unsearchable: the graph store rejected the schema the worker creates at
  startup, and each ingestion job then failed with `Type with name 'Chunk' was not
  found`. A worker that cannot create its graph schema now refuses to start
  instead of accepting work it will fail indefinitely. (#4)

### Operations

- The `production` GitHub environment needs a **tag** deployment policy for `v*`:
  a branch-only policy does not match a tag ref, so every tag deploy fails closed
  at the environment gate. Already added on the current deployment; any new
  environment needs it before its first release.
- **Databases created before this release need a one-time ArcadeDB repair.** The
  corrected `defaultDatabases` grant only takes effect when the database is first
  created, so an existing one keeps the broken grant and keeps refusing schema
  changes. With the container stopped, set that database's entry for the ArcadeDB
  user to `["admin"]` in `server-users.jsonl` (in the server's `config` volume),
  start it, restart the worker so the schema is created, then re-queue the failed
  documents with `POST /v1/ingestion/reindex`. A fresh deployment needs none of
  this.
- The "main protection" ruleset still allows `merge` and `rebase` alongside
  `squash`. Narrowing `allowed_merge_methods` to `["squash"]` makes the
  squash-only rule enforced rather than conventional.

### Platform baseline

Everything in this subsection was already serving traffic at
`knowledge.hrustalq.dev` before tagging began; `v0.1.0` is the first tag to name
it.

- **Platform core (plan.md phases 0–5)** — three-store separation across
  PostgreSQL (transactional truth), MinIO (raw bytes) and ArcadeDB (graph +
  vectors); the `Workspace > Project > Document` containment model; the
  outbox-driven ingestion pipeline and its BullMQ worker; an immutable revision
  DAG with branches, compare and merge requests; deterministic and LLM-inferred
  relation extraction; hybrid vector + BM25 search with graph expansion; and
  Phase 5 governance — auth, ACLs, audited operator graph queries, stale-document
  detection and historical fact queries.
- **Product features 01–26** — document view, search, editor, live dependent
  reindex, revision viewer, graph view, categorisation, nesting, AI assistant,
  activity feed, projects, per-workspace AI settings, review mode, glossary, page
  comments, import, dynamic workflows, internationalisation (en/ru), connectors,
  agents, agent mentions, notifications, identity and avatars, the project page,
  web research, and connector staging. Each is documented in
  [`docs/features/`](docs/features/).
- **Four entrypoints** — the HTTP API, the ingestion worker, an MCP server over
  stdio serving `knowledge_*` tools, and the OpenAPI schema generator.
- **Production deployment** — self-hosted runner, Docker Compose stack behind
  Caddy, `prisma migrate deploy` on rollout, health gating on loopback and on the
  public endpoint.

[unreleased]: https://github.com/hrustalq/knowledge/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/hrustalq/knowledge/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/hrustalq/knowledge/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hrustalq/knowledge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hrustalq/knowledge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hrustalq/knowledge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hrustalq/knowledge/releases/tag/v0.1.0
