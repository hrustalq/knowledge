# Contributing

`plan.md` is the authoritative architecture document and `CLAUDE.md` carries the
code-level conventions and gotchas. This file covers only **process**: how a
change travels from a branch to production.

## Setup

```bash
make setup   # env files -> pnpm install -> infra -> migrations -> build
make dev     # infra + api :3000 (/docs) + web :5173 + ingestion worker
make help    # everything else
```

## Branch policy

`main` is the only long-lived branch. Everything else is short-lived and deleted
on merge.

**There is no `develop` and there are no `release/*` branches**, deliberately.
Gitflow exists to maintain several released versions in parallel; this project has
one environment and supports exactly one version — the tag currently deployed. A
`develop` branch would add a merge hop and a second thing to keep green without
buying anything.

| Branch          | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `main`          | Integration. Always releasable. **Not live.**        |
| `<type>/<slug>` | One change. Branch from `main`, PR back into `main`. |
| `hotfix/vX.Y.Z` | Exception only — see [Hotfix](#hotfix).              |

Branch names use the commit types below: `feat/confluence-incremental-pull`,
`fix/nil-uuid-workspace`, `chore/bump-turbo`, `docs/versioning`. Worktrees created
by tooling (`worktree-*`) are local scratch — rename before pushing.

`main` is protected by the **"main protection" repository ruleset**: a pull
request is required, the `check` status check must pass, and force-push and
deletion are blocked. Required approvals is deliberately **0** — GitHub forbids
approving your own pull request, so requiring 1 would deadlock a solo repository.

Squash-only is currently **convention, not enforcement**: the ruleset still
permits merge and rebase. Narrowing `allowed_merge_methods` to `["squash"]` is
what would make rule 2 below true by construction.

## Commits

**Every commit** follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/),
enforced by `.husky/commit-msg` running commitlint. A commit that does not parse
is rejected locally.

```
<type>(<scope>)<!>: <subject>

<body — why, not what>

<footers>
```

- **type** — `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
  `chore`, `style`, `revert`.
- **scope** _(optional)_ — the area touched: `api`, `web`, `contracts`, `workflow`,
  `observability`, `mcp`, `worker`, `infra`, `deps`, or a feature slug such as
  `connectors`, `glossary`, `agents`.
- **subject** — imperative, lowercase, no trailing period, ≤ 100 chars total
  header. `feat(web): add saved filter rail`, not `feat(web): Added SavedFilterRail.`
- **`!`** — a breaking change, paired with a `BREAKING CHANGE:` footer explaining
  what a consumer must do. See [docs/versioning.md](docs/versioning.md#bump-rules)
  for what actually counts as breaking.
- **body** — this codebase documents _why_, not _what_; the diff already says what.
  A `feat` or `fix` without a body explaining the reasoning is an incomplete commit.

```
fix(api): reject nil-style uuids in workspace ids

class-validator's @IsUUID() rejects a nil uuid because the version digit must
be 1-5, so the demo workspace id was silently 400ing every seeded request.
```

## Pull requests

1. Branch from an up-to-date `main`.
2. `make verify` passes locally (the pre-push hook runs it — `verify`, not `check`,
   because `check` rebuilds `apps/api/dist` and takes a running dev server down
   with it).
3. Add the changelog entry to `## [Unreleased]` **in this PR**, using
   [docs/templates/changelog-entry.md](docs/templates/changelog-entry.md). Skip
   only for changes that are genuinely not notable — refactors, tests, CI, silent
   dependency bumps.
4. The **PR title is the commit message**: merges are squash-only, so the title
   must itself be a valid conventional commit header. Commits inside the branch are
   individually linted but collapse away.
5. CI (`make check`, including `build`) must be green.

## Release

Merging integrates. **Tagging deploys** — `.github/workflows/deploy.yml` triggers
on `v*.*.*` and on nothing else.

```bash
# 1. main is green and has what you want to ship
git checkout main && git pull
git log --oneline "$(git describe --tags --abbrev=0)..main"

# 2. Pick the bump from those commits: feat! -> MINOR (pre-1.0), feat -> MINOR,
#    fix/perf -> PATCH. See docs/versioning.md.

# 3. Move [Unreleased] to the new heading, date it, update the compare links,
#    and bump the version surfaces listed in docs/versioning.md#known-drift:
#      apps/api/src/config/swagger.ts   .setVersion('X.Y.Z')
#      apps/api/src/mcp/mcp.service.ts  new McpServer({ version: 'X.Y.Z' })
git commit -am "chore(release): vX.Y.Z"
git push

# 4. Tag the release commit. This is the deploy.
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Then watch the run: it builds both images sequentially, applies migrations, rolls
out, and gates on loopback health plus the public endpoint.

### Rollback

Code rolls back by retag; **the database does not roll back at all**.

```bash
ssh knowledge-prod
docker tag knowledge-api:vX.Y.Z knowledge-api:latest
docker tag knowledge-web:vX.Y.Z knowledge-web:latest
docker compose -f /srv/knowledge/docker-compose.prod.yml up -d
```

This only works because every migration is required to run against the previous
release's image — the expand/contract rule in
[docs/versioning.md](docs/versioning.md#rollback-and-the-expandcontract-rule). A
release that breaks that rule is one you cannot undo, and it must say so in the
changelog's **Operations** section before it ships.

### Hotfix

Normally there is no hotfix flow: fix on `main`, tag a PATCH, done.

Branch from the **tag** only when `main` already contains work you are unwilling
to ship:

```bash
git checkout -b hotfix/v0.4.1 v0.4.0
# fix, PR into main as usual, then tag the hotfix branch's commit
```

## Rules

1. **`main` is always releasable.** Anyone may tag it without asking.
2. **Squash merge only.** The PR title becomes history.
3. **Every migration is expand/contract** and runnable by the previous release.
4. **A new required env var with no default is a breaking change** — `env.ts`
   validates with zod and fails fast, so a missing variable does not degrade, it
   refuses to boot. Give it a default, or write the **Operations** entry.
5. **Never commit secrets.** `/srv/knowledge/.env` is hand-managed on the box and
   no workflow touches it.
6. **`deploy.yml` never runs on `pull_request`** — it is self-hosted and this repo
   is public. Do not add a trigger a fork can cause.
7. **New routes need `@Access(role, source)`**, or they are authenticated-only with
   no workspace check. Test ACLs with a bootstrapped key, not in `AUTH_MODE=none`.
8. Code-level conventions — ESM `.js` suffixes, buildless package constraints, the
   module splits that keep controllers out of the worker — live in `CLAUDE.md`.
   Read it before your first change.
