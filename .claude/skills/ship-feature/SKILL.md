# Shipping a feature

This repo separates integration from release, and almost every mistake comes
from forgetting that:

> **Merging integrates. Tagging deploys.** `.github/workflows/deploy.yml` fires
> on `v*.*.*` tags and on nothing else.

So "merge my PR" leaves production untouched. If someone asks you to ship,
release or deploy, the job is not finished until a tag is pushed **and** you
have seen production report the new version.

Two long-lived branches, and which one you are on decides everything:

- **`dev`** is integration. Features land here. `## [Unreleased]` accumulates
  here. It must stay green.
- **`main`** is the released state. Between releases it equals the deployed tag,
  so it is also the answer to "what is live?". It is still not live until a tag
  is pushed.

This skill starts from work that already exists in the tree and ends at a
verified deploy. Writing the feature is ordinary coding and is not covered here.

## The shape of it

```
work in tree
  -> feature branch (from main) -> changelog entry -> PR --base dev -> CI -> squash   (integrates)
  -> chore/release-vX.Y.Z (from dev) -> version bump -> PR --base dev -> CI -> squash
  -> PR --base main --head dev -> CI -> MERGE COMMIT                    (promotes)
  -> tag vX.Y.Z on origin/main -> push                                  (deploys)
  -> watch the run -> verify the deployed version
```

A feature is one PR. A release is two more. Nothing is merged back afterwards —
see the sync trap below.

## Stage 0 — know what you are shipping

Read `git status` before doing anything. If the tree holds work that is not part
of what you are shipping, do **not** `git add -A`. Stage explicitly by path, and
where a single file mixes your change with someone else's, stage one hunk:

```bash
git diff -U3 -- path/to/file > /tmp/f.patch   # then keep only your hunks
git apply --cached /tmp/f.patch
git diff --cached --stat                      # always read this back
```

Committing someone's half-finished refactor inside your feature is both hard to
review and hard to undo. If you cannot tell which changes are yours, ask.

## Stage 1 — the feature PR

1. Branch **from `main`**: `git fetch origin && git switch -c feat/<short-name> origin/main`
   (or `fix/`, `docs/`…). `main` is the last state that ran in production, which
   is the honest base for new work. Branch from `origin/dev` instead only when
   your change builds on something unreleased that is already merged there.

2. **Write the changelog entry now, in this PR.** `CHANGELOG.md` under
   `## [Unreleased]`, following `docs/templates/changelog-entry.md`. Recreate
   that heading if a release just consumed it. Entries are written here rather
   than at release time because writing them later means writing them from
   `git log`, which is how "Update dependencies and refactor application
   modules" ends up in front of a reader.

   Write for someone operating or consuming the system, not for the author:
   the symptom, not the patch. An **Operations** section is required whenever
   the change adds an env var, ships a migration that is not reversible under
   the expand/contract rule, or needs a manual step. A **Breaking** entry
   without a `**Migration:**` line is not ready.

   Skip the entry entirely for pure refactors, tests, formatting, CI tweaks and
   dependency bumps that change no behaviour.

3. Commit with a conventional-commit subject. **The PR title becomes the commit
   on `dev`** — PRs into `dev` are squash-merged by ruleset — so the title is the
   thing that has to read well in history, and a PR containing both a fix and a
   feature will land under one of them.

4. Push. `.husky/pre-push` runs `make verify` (db-generate, lint, typecheck,
   dependency rules, tests). It deliberately omits `build`, which CI covers —
   so a green push is not proof the build works.

5. `gh pr create --base dev`. **Pass the flag.** GitHub bases a new PR on the
   default branch, which is deliberately still `main`; without `--base dev` you
   open a promotion PR carrying one feature, and `main` will only offer to merge
   it as a merge commit. Explain the reasoning, not just the diff; if you did not
   write the code, say so in the PR, because a reviewer reading a confident
   description assumes the author understood the intent.

6. Wait for `check`, then `gh pr merge <n> --squash` (see **Waiting for CI**).

That is the whole job for a feature. Stop here unless you were asked to release.

## Stage 2 — the version bump, on `dev`

Pick the number from the commits since the last tag, per `docs/versioning.md`:

```bash
git fetch origin
git log --oneline "$(git describe --tags --abbrev=0)..origin/dev"
```

| commits since last tag | bump (pre-1.0)            |
| ---------------------- | ------------------------- |
| any `feat`             | **MINOR** — 0.6.0 → 0.7.0 |
| only `fix` / `perf`    | **PATCH** — 0.6.0 → 0.6.1 |
| `feat!` / breaking     | **MINOR** while under 1.0 |

```bash
git switch -c chore/release-vX.Y.Z origin/dev
```

Three edits, and only these three:

1. `CHANGELOG.md` — `## [Unreleased]` becomes `## [X.Y.Z] — YYYY-MM-DD`. Do not
   leave an empty `[Unreleased]` heading behind. Update the link block at the
   bottom: point `[unreleased]` at `compare/vX.Y.Z...HEAD` and add
   `[X.Y.Z]: compare/v<prev>...vX.Y.Z`.
2. `apps/api/src/config/swagger.ts` — `.setVersion('X.Y.Z')`.
3. `apps/api/src/mcp/mcp.service.ts` — `new McpServer({ ..., version: 'X.Y.Z' })`.

Those two source files are the known drift listed in
`docs/versioning.md#known-drift`; every other package stays at `0.0.0` on
purpose, because nothing here is published and per-package semver would be
bookkeeping nobody reads. The authoritative version is the git tag.

Commit as `chore(release): vX.Y.Z`, push, `gh pr create --base dev`, wait for
`check`, squash merge.

## Stage 3 — the promotion PR

```bash
git fetch origin
gh pr create --base main --head dev \
  --title "chore(release): promote vX.Y.Z" \
  --body "Promotes vX.Y.Z to main. Tag follows."
```

This PR's diff **is** the release — it carries nothing of its own, which is why
it is worth reading whole before merging. Wait for `check`, then:

```bash
gh pr merge <n> --merge      # NOT --squash. See the traps.
```

`main`'s ruleset permits only a merge commit, so a mistaken `--squash` fails
rather than doing damage — but know why: squashing `dev` into `main` rewrites
every SHA, leaving the branches permanently diverged and every later promotion
replaying already-released work.

## Stage 4 — the tag, which is the deploy

Tag **the commit that landed on `main`**.

```bash
git fetch origin --tags
git tag -l 'v*'                                    # confirm it does not exist
git tag -a vX.Y.Z "$(git rev-parse origin/main)" -m "vX.Y.Z"
git push origin vX.Y.Z
```

`deploy.yml` refuses a tag that is not an ancestor of `origin/main` — correctly,
but only after you have pushed it and have to delete it again. That is what
catches a tag cut from `dev`, or from your local release commit whose SHA the
squash rewrote.

Do not merge anything into `dev` between Stage 3 and here: the tag should be the
commit the promotion PR was reviewed as.

This is the irreversible, outward-facing step. Unless the user has already asked
for a deploy in this conversation, say what you are about to push and confirm
first. Approval to merge is not approval to deploy.

## Stage 5 — watch, then verify

The run builds both images sequentially (a 3.8 GB box cannot afford parallel
`tsc`), applies migrations, rolls out, then gates on loopback health and the
public endpoint.

```bash
RID=$(gh run list --workflow=deploy.yml --limit 8 --json databaseId,headBranch \
      --jq '[.[] | select(.headBranch=="vX.Y.Z")][0].databaseId')
gh run view "$RID" --json status,conclusion,url --jq '{status,conclusion,url}'
```

Poll until `completed`, printing the in-progress step so a stall is visible.

Then verify independently — **a 200 only proves the box is up, not that the new
image is serving**:

```bash
curl -s https://knowledge.hrustalq.dev/api/docs-json |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const j=JSON.parse(s); console.log('deployed:', j.info?.version)})"
```

If that does not print the version you just tagged, the deploy did not take
effect no matter how green the run looked. Report the real state.

## Waiting for CI

`gh pr checks <n> --watch` has been observed returning while checks are still
pending, which reads as success. Poll the rollup instead:

```bash
for i in $(seq 1 26); do
  PENDING=$(gh pr view <n> --json statusCheckRollup \
    --jq '[.statusCheckRollup[] | select(.status != "COMPLETED")] | length')
  gh pr view <n> --json statusCheckRollup \
    --jq '[.statusCheckRollup[] | (.name // .context) + "=" + (.conclusion // .status)] | join(" ")'
  [ "$PENDING" = "0" ] && break
  sleep 20
done
gh pr view <n> --json mergeable,mergeStateStatus,state
```

CI runs the full `make check` (lint, typecheck, dependency rules, tests, build)
on a GitHub-hosted runner, on every PR regardless of base. Merge only on
`SUCCESS` — never on "it passed locally", because the pre-push hook skips
`build`.

## Traps

Each of these has actually happened here, or is the failure the branch layout
was designed around.

- **`gh pr create` defaults to `main`.** The default branch is still `main` on
  purpose (features are cut from it), so a feature PR without `--base dev`
  silently becomes a promotion PR. Check the base before merging anything.
- **Never squash the promotion PR**, and never force a fast-forward of one
  branch onto the other. `main` keeps `dev`'s commits reachable; that is what
  makes the next promotion's merge base correct.
- **There is no sync step, and adding one is the mistake.** The promotion merge
  commit already carries `dev`'s exact tree onto `main`, and the next promotion
  PR's merge base is the previous `dev` head — so the branches never drift in
  content. `dev` reading as "behind `main`" in GitHub's UI is cosmetic: those
  merge commits contain nothing. The **one** exception is a hotfix, which lands
  on `main` directly and must be cherry-picked back onto `dev`, or the next
  release silently reverts it.
- **`set -e` does not catch a git command inside a pipe.** `git checkout main |
tail -2` reports the exit status of `tail`, so a refused checkout sails past
  the guard and the next command runs against the wrong branch. Do not pipe a
  git command whose failure must stop the script.
- **`git checkout <branch>` is refused when the tree is dirty** and a file
  differs between branches. Use `git fetch origin main:main` to fast-forward a
  ref without touching the working tree, and branch with an explicit
  `git switch -c <new> origin/<base>` rather than checking the base out first.
- **Do not regenerate `openapi.json` during a release.** The runbook bumps two
  source files and nothing else; `make api-client` regenerates from the _current
  tree_, so it will sweep in any unrelated uncommitted DTO changes.
- **Never run the API from the repo root.** `i18n.config.ts` writes its types to
  `join(process.cwd(), 'src/i18n/i18n.generated.ts')`, so a root-cwd run emits a
  stray `src/i18n/` beside the repo's real one. Run from `apps/api`.
- **`make check` kills a running dev server**, because its `build` step rewrites
  `apps/api/dist` under `nest start --watch`. Use `make verify` while the dev
  server is up.
- **A release that ships a migration needs an Operations entry** saying whether
  it survives a rollback. Code rolls back by retag; the database does not roll
  back at all.
- **Shell search lies in this repo.** `rtk grep`, `rg` and `node -e` substring
  probes have all reported "not found" for text that was present. Treat any
  shell "no matches" as unproven — use the Read tool, or `rtk proxy grep`.

## Rollback

Code only, and only because every migration is required to run against the
previous release's image:

```bash
ssh knowledge-prod
docker tag knowledge-api:vX.Y.Z knowledge-api:latest
docker tag knowledge-web:vX.Y.Z knowledge-web:latest
docker compose -f /srv/knowledge/docker-compose.prod.yml up -d
```

## Reporting

State what actually happened: the PR numbers, the tag, the run conclusion, and
the version production reported back. If a step was skipped or a check was not
waited for, say which. A release summary that implies verification you did not
perform is worse than no summary, because it is the thing someone will rely on
when production misbehaves an hour later.
