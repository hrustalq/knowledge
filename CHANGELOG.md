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

## [Unreleased]

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

[Unreleased]: https://github.com/hrustalq/knowledge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hrustalq/knowledge/releases/tag/v0.1.0
