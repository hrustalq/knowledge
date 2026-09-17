# Versioning

One version number for the whole platform, cut as a git tag, and the tag is what
deploys. This document defines what the number promises, and — more usefully —
what it does _not_.

## One version, not seven

Every package in this repo is `private: true` and nothing is published to a
registry, so per-package semver would be bookkeeping nobody reads. `@knowledge/api`,
`@knowledge/web`, `@knowledge/contracts`, `@knowledge/workflow`,
`@knowledge/observability` and `@knowledge/tsconfig` stay at `0.0.0` **on purpose**
— they are internal modules of one deployable, not distributable libraries.

The version that means something is the **product version**, and it lives in the
git tag `vX.Y.Z`. Nothing else is authoritative.

### Known drift (fix before v1.0.0)

Four surfaces declare a version, and none of them derives it from the tag:

| Surface                                           | Declares  | Should be          |
| ------------------------------------------------- | --------- | ------------------ |
| `apps/api/src/config/swagger.ts` `.setVersion()`  | `0.6.0`   | the tag            |
| `apps/api/src/mcp/mcp.service.ts` `new McpServer` | `0.6.0`   | the tag            |
| `apps/api/package.json`                           | `0.0.1`   | `0.0.0` (internal) |
| root `package.json`                               | _(unset)_ | the tag, or unset  |

The first two match `v0.6.0` today, and that is the drift rather than the cure:
they are correct only because the release runbook in
[CONTRIBUTING.md](../CONTRIBUTING.md#release) bumps them **by hand** every time,
so they are one forgotten step away from lying — which is exactly what the
`0.1.0` / `0.3.0` this table used to record were. A number that is accurate
because somebody remembered is not a number you can read.

The eventual fix is one build arg (`APP_VERSION`, set from `github.ref_name` in
`deploy.yml`) read by both call sites, defaulting to `0.0.0-dev` outside a release
build. It is not done yet because it touches `swagger.ts`, `mcp.service.ts` and
both Dockerfiles, and a wrong version string is a cosmetic bug where a wrong
deploy is not.

## The compatibility surface

A version number is a promise to somebody. Here, "somebody" is one of four
consumers — and the bump rules below are derived from what breaks _them_, not from
how big the diff felt.

1. **The HTTP API** — 152 paths, described by the committed `apps/api/openapi.json`.
   Consumed by the generated web client (`apps/web/src/api/schema.d.ts`) and by
   anything else holding an API key.
2. **The MCP tool surface** — the `knowledge_*` tools served over stdio. These are
   consumed by agent clients _outside this repository_, which is the most public
   thing the project has: nobody here controls when they upgrade.
3. **The configuration contract** — `.env.example`, and the zod schema in
   `apps/api/src/config/env.ts` that **fails fast on boot**. A new required
   variable with no default does not degrade; it refuses to start. That makes it a
   breaking change to an operator even though no code signature moved.
4. **The database** — migrations are forward-only and applied automatically by
   `prisma migrate deploy` during the deploy job. See [Rollback](#rollback-and-the-expandcontract-rule).

Deliberately **not** covered: internal package APIs, the Prisma schema's internal
shape, UI layout and copy, log formats, and anything under `docs/`. Those change
freely at any bump level.

## Bump rules

### MAJOR — a consumer must change something

- A route removed, renamed, or moved.
- A response field removed, or narrowed (`string` → enum, nullable → non-nullable).
- A request field made required, or its validation tightened.
- An MCP tool removed or renamed, or one of its arguments made required.
- A new **required** env var with no default, or a default changed in a way that
  alters behaviour on an existing deployment.
- An error `code` in `API_ERROR_CODES` removed or repurposed.
- A migration that the previous release's image cannot run against (see below).

### MINOR — new capability, nothing existing moves

- A new route, a new MCP tool, a new optional request field, a new response field.
- A new env var **with** a working default.
- A new event type in `KNOWN_EVENT_TYPES`, a new notification category, a new
  connector kind, a new agent, a new workflow step kind.
- A whole feature under `docs/features/` shipping.

### PATCH — nothing on the surface moves

- Bug fixes, performance, dependency bumps, docs, tests, refactors, UI changes
  that add no new API.

### While 0.x

Semver §4: pre-1.0, anything may change. In this repo that is narrowed by
convention so the number still carries information:

> A MAJOR-class change bumps **MINOR** while the version is `0.x`, but it is still
> written `feat!:` / `fix!:`, still carries a `BREAKING CHANGE:` footer, and still
> gets a **Breaking** section in the changelog.

So `0.7.0 → 0.8.0` may contain a break and `0.8.0 → 0.8.1` never does. Reaching
`1.0.0` is the decision that MAJOR starts costing a major number — take it when
the MCP tool surface has outside consumers you are unwilling to page.

## Rollback and the expand/contract rule

This is the rule that matters most, and it is a consequence of how deploys work
rather than of semver.

Images are tagged with both the version and the commit SHA, so **rolling back code
is a retag**, not a rebuild. But `prisma migrate deploy` is forward-only: the
database does not roll back with it. Therefore:

> **Every migration must be runnable by the previous release's image.**

That makes a destructive schema change **two releases**, never one:

| Release | Does                                                                      |
| ------- | ------------------------------------------------------------------------- |
| `N`     | _Expand._ Add the new column nullable, backfill it, write to both shapes. |
| `N+1`   | _Contract._ Switch reads over, then drop the old column.                  |

`apps/api/prisma/migrations/20260907160044_projects_layer` is the worked example of
the nullable → `UPDATE` → `SET NOT NULL` shape (and of why `make db-migrate-new`
cannot express it — see the gotcha in `CLAUDE.md`).

A release that violates this is not merely a MAJOR bump — it is a release you
cannot undo. Say so in the changelog's **Operations** section, out loud.

## What the tag does

`vX.Y.Z` is not a label applied after the fact. Pushing it **is** the deploy:
`.github/workflows/deploy.yml` triggers on `v*.*.*` and on nothing else. `dev` is
integration; `main` is the released state, and even `main` is not live until the
tag is pushed.

Three consequences worth internalising:

- `## [Unreleased]` in the changelog is now _honest_. Merged work sits in `dev`,
  built and tested but not serving traffic, until a release promotes it.
- `dev` must stay releasable at every commit, because the promotion PR is the only
  gate between it and a tag.
- Between releases, `main` **equals the deployed tag**. That makes "what is
  running in production?" a question you answer by reading a branch, and it is the
  reason the promotion hop exists at all — see
  [CONTRIBUTING.md](../CONTRIBUTING.md#branch-policy).

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the branch policy and the release
runbook that follows from this.
