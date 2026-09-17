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

`main` and `dev` are long-lived. Everything else is short-lived and deleted on
merge.

Work integrates on `dev` and is **promoted** to `main` by pull request; the tag is
then cut from `main`. This repo ran a single trunk until v0.6.0 and this file used
to argue against a second branch — that a `develop` branch "would add a merge hop
and a second thing to keep green without buying anything". What it buys, now that
the hop is being paid for:

1. **`main` is a record of what production has served.** Between releases `main`
   equals the deployed tag, so _what is live_ is answerable by reading a branch
   instead of diffing tags.
2. **Unreleased work no longer sits on the branch the deploy tags from.** Every
   merge to `main` used to be one `git tag` away from shipping. Shipping now takes
   an explicit promotion PR.
3. **Feature branches base on the released state** — every branch starts from a
   commit that has actually run in production.

It is still not Gitflow: there are no `release/*` branches and no parallel
supported versions. One environment, one live version, one extra hop.

| Branch                 | Purpose                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `main`                 | Released state. Each commit is a release or the promotion about to be one.  |
| `dev`                  | Integration. Always green. Where `## [Unreleased]` accumulates.             |
| `<type>/<slug>`        | One change. Branch from `main`, PR into `dev`.                              |
| `chore/release-vX.Y.Z` | Version bump. Branch from `dev`, PR into `dev` — see [Release](#release).   |
| `hotfix/vX.Y.Z`        | Exception only — branch from `main`, PR into `main`. See [Hotfix](#hotfix). |

Branch from `dev` instead of `main` when your work builds on something unreleased
that is already merged there. Otherwise branch from `main`: it is the last state
that ran in production, which is the honest base for a new change.

Branch names use the commit types below: `feat/confluence-incremental-pull`,
`fix/nil-uuid-workspace`, `chore/bump-turbo`, `docs/versioning`. Worktrees created
by tooling (`worktree-*`) are local scratch — rename before pushing.

Both branches are protected by repository rulesets — **"main protection"** and
**"dev protection"** — requiring a pull request, a passing `check`, and blocking
force-push and deletion. Neither has bypass actors: `main` cannot be pushed to by
anyone, including the owner. Required approvals is deliberately **0** — GitHub
forbids approving your own pull request, so requiring 1 would deadlock a solo
repository.

Squash-only is no longer convention but **enforcement**, and it differs per
branch, because `allowed_merge_methods` is evaluated against a PR's base:

- **`dev` permits only `squash`.** The PR title becomes the commit.
- **`main` permits only `merge`.** A promotion must keep `dev`'s commits reachable
  from `main`. Squashing `dev` into `main` would rewrite every SHA, leaving the two
  branches permanently diverged and every later promotion replaying released work.

That is also why nothing needs syncing back after a release: the promotion merge
commit carries `dev`'s tree onto `main` wholesale, and the next promotion PR's
merge base is the previous `dev` head, so the two branches never drift in content.
`dev` will read as "behind `main`" in GitHub's UI by one merge commit per release,
which is cosmetic — those commits contain nothing. A real back-merge is needed
only after a [hotfix](#hotfix).

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

1. Branch from an up-to-date `main`, and **target `dev`**:
   `gh pr create --base dev`. GitHub bases a new PR on the default branch, which
   is deliberately still `main` — pass the flag, or you open a promotion PR by
   accident.
2. `make verify` passes locally (the pre-push hook runs it — `verify`, not `check`,
   because `check` rebuilds `apps/api/dist` and takes a running dev server down
   with it).
3. Add the changelog entry to `## [Unreleased]` **in this PR**, using
   [docs/templates/changelog-entry.md](docs/templates/changelog-entry.md). Skip
   only for changes that are genuinely not notable — refactors, tests, CI, silent
   dependency bumps.
4. The **PR title is the commit message**: merges into `dev` are squash-only, so
   the title must itself be a valid conventional commit header. Commits inside the
   branch are individually linted but collapse away.
5. CI (`make check`, including `build`) must be green.

## Release

Merging integrates. **Tagging deploys** — `.github/workflows/deploy.yml` triggers
on `v*.*.*` and on nothing else.

Two pull requests: the bump lands on `dev`, then `dev` is promoted to `main`. The
promotion PR therefore carries nothing of its own, which is the point — its diff
_is_ the release, and it is the last chance to read that diff whole.

```bash
# 1. dev is green and has what you want to ship
git fetch origin
git log --oneline "$(git describe --tags --abbrev=0)..origin/dev"

# 2. Pick the bump from those commits: feat! -> MINOR (pre-1.0), feat -> MINOR,
#    fix/perf -> PATCH. See docs/versioning.md.

# 3. Move [Unreleased] to the new heading, date it, update the compare links,
#    and bump the version surfaces listed in docs/versioning.md#known-drift:
#      apps/api/src/config/swagger.ts   .setVersion('X.Y.Z')
#      apps/api/src/mcp/mcp.service.ts  new McpServer({ version: 'X.Y.Z' })
#
#    The bump travels by pull request like every other change — `dev` requires
#    one plus a passing `check`, so pushing it straight to dev is rejected.
git switch -c chore/release-vX.Y.Z origin/dev
git commit -am "chore(release): vX.Y.Z"
git push -u origin chore/release-vX.Y.Z
gh pr create --base dev --title "chore(release): vX.Y.Z" --fill   # squash when green

# 4. Promote. This PR's diff is the release; the ruleset offers only a merge
#    commit, because squashing dev into main would diverge them permanently.
git fetch origin
gh pr create --base main --head dev --title "chore(release): promote vX.Y.Z" \
  --body "Promotes vX.Y.Z to main. Tag follows."

# 5. Tag the commit that LANDED ON MAIN. This is the deploy.
#    deploy.yml refuses a tag that is not an ancestor of origin/main, so a tag cut
#    from dev — or from your local release commit, whose SHA the squash rewrote —
#    fails the ancestry check only after you have pushed it and have to delete it.
git fetch origin --tags
git tag -l 'v*'                                    # confirm it does not exist
git tag -a vX.Y.Z "$(git rev-parse origin/main)" -m "vX.Y.Z"
git push origin vX.Y.Z
```

Nothing is merged back afterwards: step 4's merge commit already put `dev`'s exact
tree on `main`. Do not merge features into `dev` between steps 4 and 5 — the tag
should be the commit the promotion PR was reviewed as.

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

A hotfix is the one change that does **not** integrate on `dev`: it branches from
`main` and PRs straight back into `main`, skipping the queue of unreleased work.

```bash
git fetch origin
git switch -c hotfix/v0.6.1 origin/main       # or a tag, if main is mid-promotion
# fix, then:
gh pr create --base main --title "fix(api): ..." --fill
# merge (a merge commit — main permits nothing else), then tag as in Release step 5
```

Keep the branch to **one commit**: `main` does not squash, so every commit on it
survives into history.

Then back-merge, because this is the one case where `main` holds content `dev` has
never seen. Cherry-pick rather than merging `main` into `dev` — the fix is what
`dev` needs, not the release merge commits:

```bash
git switch -c chore/backport-v0.6.1 origin/dev
git cherry-pick <the hotfix commit on main>
gh pr create --base dev --title "fix(api): ... (backport)" --fill
```

Skipping the backport means the next release silently reverts the hotfix.

## Rules

1. **`dev` is always releasable**, because a promotion PR is the only gate between
   it and a tag. `main` is the released state; tagging its head is the deploy, and
   anyone may do so without asking.
2. **Squash into `dev`, merge-commit into `main`.** Both are enforced by ruleset,
   not convention. The PR title becomes history on `dev`.
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
