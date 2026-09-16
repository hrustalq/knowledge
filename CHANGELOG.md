# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with two additions this project needs — **Breaking** and **Operations** — and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
narrowed in [docs/versioning.md](docs/versioning.md).

`[Unreleased]` is work merged to `main` that is **built, tested and not serving
traffic**. Production moves only when a `vX.Y.Z` tag is pushed. Entries are written
in the pull request that introduces them — see
[docs/templates/changelog-entry.md](docs/templates/changelog-entry.md).

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

[unreleased]: https://github.com/hrustalq/knowledge/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/hrustalq/knowledge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hrustalq/knowledge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hrustalq/knowledge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hrustalq/knowledge/releases/tag/v0.1.0
