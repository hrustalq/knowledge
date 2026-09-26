# 35 — Drift check on pull and merge requests

Оригинал: «let's extend github / gitlab connectors functionality - mr / pr
triggered related documents check and update if needed to prevent
documentation drift»

## What

A repository connector (`codebase` or `markdown-git`) can now watch its
repository's pull requests (GitHub) and merge requests (GitLab). When one opens,
is reopened, leaves draft or gets new commits, a background agent — the
**sentinel** — reads the change, finds the pages in the knowledge base that are
about the code it touches, and decides page by page whether the change makes
something on it untrue. For every page that drifted it drafts the corrected
page.

What happens next is the connector's **Drift check** setting:

| Mode      | What the check does                                                                   |
| --------- | ------------------------------------------------------------------------------------- |
| `off`     | Nothing. The default, and what every existing connector reads as.                      |
| `report`  | Findings on an agent run, and **one** comment on the pull request, updated on every push. |
| `propose` | `report`, plus a merge request here for every page it drafted a correction for.         |

Pages are only ever changed by a person merging those merge requests.

## Why

Documentation drifts at the moment code changes, and the moment code changes is
a pull request. Feature 27 derives pages from a repository and feature 31 finds
the logic nobody documented, but both look at the repository *as it is*; neither
notices that the page describing the retry policy became wrong the day somebody
renamed the option. Scheduled re-sync refreshes the derived module pages — it
does nothing for the hand-written design doc that quotes the old default.

The pull request is also the one place the author is still looking. A drift
report in the product a week later is a chore; a comment on the pull request
before it merges is a checklist item.

## Decisions

**A sixth background agent, not a workflow.** Feature 29 settled where a long
unattended model loop lives: a `RUNNABLE_AGENTS`-shaped case in `AgentExecutor`,
with a durable run row, an owner rehydrated into a real principal, a budget
check at execution, progress, and findings a person acts on. A drift check is
exactly that shape, and it reuses the finding → merge request path the Propose
button already takes. A workflow (feature 17) runs *against a page*; a pull
request has no page until this check finds one.

The sentinel is **not** in `RUNNABLE_AGENTS`. That set is what offers a Run
button and what the schedule sweeper reads, and a sentinel run without a pull
request has nothing to check — so only the executor switch knows it, and only
`DriftTriggerService` starts one. Its roster entry,
prompt and model routing are ordinary: an admin edits and routes it like any
other agent, and disabling it turns every drift check off.

**The worker generates, the API publishes — including the comment.** The
executor reads the diff and judges pages; it writes nothing but the run.
`DriftPublishSweeper`, API-side, opens the merge requests through the same
`AgentFindingsService.propose` the button calls (so a person pressing Propose
concurrently cannot open a second one) and writes the pull request comment.
A comment on somebody's pull request is an outward write, which is exactly what
the rule keeps away from an unattended process. `PullRequestService` in the
worker-loaded `CodeResearchModule` is therefore read-only on purpose.

**The deterministic half ties pages; the model only judges.** The archaeologist
shape, pointed at a diff. `agents/drift.ts` is Nest-free and tested:

- *Linked* — pages the connector wrote. For `codebase` a changed file ties to
  the **deepest** `module:` link that contains it (the repo map's own
  deepest-root-wins rule; otherwise a monorepo's root module claims every
  change), and a changed manifest or an added, removed or moved file ties to
  the `overview` hub, whose subject is the repository's shape.
- *Mentioned* — pages under the connector's destination that name a changed
  file by path, by its old path, or by a filename specific enough to mean it —
  the archaeologist's `isCovered`, asked the other way round.
- *Searched* — at most three hits for the change's title and file names, because
  the page most likely to drift is a hand-written one no link reaches.

Strongest tie first, eight pages at most: one model call each is the cost. A
`markdown-git` page the change **itself** edits is excluded — it is the change
documenting itself, and the next sync after merge updates it.

**A head is checked once; a waiting check absorbs a newer head.** The run's
`headSha` is the identity. A repository with the GitHub App installed *and* a
hand-configured hook delivers every event twice, and GitHub redelivers on a slow
answer; the same head again starts nothing. Three pushes in a minute rewrite the
still-pending run's input and produce one check of the third head — the
connector sync's coalescing rule, for its reason. A workspace holds at most
twenty waiting checks.

**Which deliveries count.** GitHub: `opened`, `reopened`, `synchronize`,
`ready_for_review`. GitLab: `open`, `reopen`, and `update` **only with
`oldrev`** — GitLab fires `update` for a title edit too, and only a push carries
the old revision. Drafts are skipped (`ready_for_review` picks them up). A title
edit, a label or an assignee is not a change to the code.

**Forks are never checked.** A run spends the connector owner's AI budget. On a
public repository a fork's pull request is a stranger pressing that button, so
a delivery whose head repository differs from its base — or whose fork was
deleted — starts nothing.

**No owner, no check.** `agent_runs.created_by` is NOT NULL and a run acts as a
person; `connectors.created_by` is nullable. An ownerless connector skips the
check with a log line — feature 27's "no owner, no spend".

**The corrected page rides on the finding, and Propose publishes it as-is.** The
judgement returns the complete corrected page while the diff is in front of the
model. Handing it to the drafter again would pay a second call to re-derive,
without the diff, what the first already said. So a finding that carries a
`draft` *and* cites a page is proposed from the draft, with no model call and no
budget check. A draft shorter than 200 characters, or identical to the page, is
dropped and the finding stays as a warning a person resolves by hand.

That exposed an older bug in the same path: `propose` wrote the drafter's body,
which is written without frontmatter, as the whole revision — so every proposal
silently dropped the page's `tags:`, `relations:` and `source:`. Both paths now
put the current frontmatter back.

**One comment, found again by a marker.** `<!-- knowledge:drift-check:<connectorId> -->`
— keyed by connector, so two connectors watching one repository keep a comment
each. It is created on the first check that finds drift, edited on every later
one (including to say the drift is resolved), and never created for a clean
check nobody was warned about. Only the first hundred comments are searched; a
very long thread may get a second one, which is cosmetic against a request per
page on every push. Page details written by a model are flattened to one line,
HTML-escaped, and have `@` defused so a handle quoted from a page notifies
nobody.

**Published at most once.** The sweeper claims a run by stamping
`input.publishedAt` in one guarded statement before writing anything. A comment
that fails is logged and not retried: the next push starts a new check, and a
sweeper that retried a failing host every tick would do nothing else. A run
finished more than a day ago is history and is not published at all, so an API
that was down for a week does not comment on last week's pull requests. A newer
check of the same pull request publishes for itself and the older stays quiet,
and a page an earlier push already proposed (and whose merge request is still
open) is linked rather than proposed twice.

**Both hooks, one verification.** The GitHub App-level hook (feature 32) already
receives `pull_request`; it now also hands the event to the drift trigger. The
per-connector hook at `/v1/connectors/:id/webhook` — the only kind GitLab has —
checks pull and merge request events **before** asking the adapter, because a
pull request is not content moving: `codebase` has no adapter webhook at all,
and `markdown-git`'s would read the missing `commits` as nothing to sync. The
check uses the connector's own webhook secret, GitHub's HMAC or GitLab's token
compared in constant time (`markdown-git`'s sync check compares GitLab's token
with `!==`, which is fine for a sync and not for a trigger that spends model
calls).

**`'webhook'` joins `AGENT_RUN_TRIGGERS`.** The vocabulary's own comment asks for
a value only together with the thing that emits it; `DriftTriggerService` is
that thing, for this one agent, and never the event bus — so none of feature
17's re-trigger guards apply.

## Surface

Connector config, on `codebase` and `markdown-git`:

| key          | values                          | default |
| ------------ | ------------------------------- | ------- |
| `driftCheck` | `off` \| `report` \| `propose` | `off`   |

The setup dialog's options step shows it for the two git kinds, with the
webhook secret beside it once it is on (optional when the repository was
connected through the GitHub App, whose hook already delivers pull requests).

Agent: `sentinel` (background, event-only). Run stages `diff`, `related`,
`judging`. `AgentRunInput.pullRequest` (`number`, `title`, `url`, `headSha`,
`headRef`, `baseRef`, `author`) and `publishedAt`. A drift finding is
`kind: 'stale'`, cites the page, carries the pull request as a web source and,
when there is one, the corrected page as `draft`.

No new endpoint, no new env var, no migration.

## Setup

**GitHub, through the App** (feature 30): nothing new. The App already
subscribes to *Pull request* and holds *Pull requests: Read and write* and
*Issues: Read and write* (feature 32), which is what the diff and the comment
need. Set **Drift check** on the connector.

**GitHub, with a token, or GitLab:** set **Drift check** and a **Webhook
secret** on the connector, then add a webhook on the repository:

| Host   | URL                                              | Secret               | Events                |
| ------ | ------------------------------------------------ | -------------------- | --------------------- |
| GitHub | `$API_PUBLIC_URL/v1/connectors/<id>/webhook`      | the secret, as *Secret* | *Pull requests*       |
| GitLab | `$API_PUBLIC_URL/v1/connectors/<id>/webhook`      | the secret, as *Secret token* | *Merge request events* |

The token needs to read the pull request's files and write a comment: on GitHub
*Pull requests: Read and write*; on GitLab the `api` scope.

## Deliberate deferrals

- **Closing a pull request does not close its proposals.** An abandoned change
  leaves its knowledge-base merge requests open for a person to close. Doing it
  automatically needs the `closed` delivery to find them, which is a query this
  feature already has — but a merge request somebody has since edited by hand
  should not vanish because a branch was abandoned.
- **Code tools read the base branch.** The judge sees the change as a diff, and
  its `code_*` tools read the connector's configured branch, which does not
  contain the change yet. Reading the head branch needs a second snapshot per
  pull request; the diff is what the judgement is about, and the base branch is
  what the page was written against.
- **One search, on the change's title.** Better recall would come from a query
  per changed symbol; it would also be the first thing to multiply the cost.
- **Proposals are not updated on a new push.** A second push that changes the
  correction links the still-open merge request from the first rather than
  adding a revision to it.

## Verification

`make verify`, and `apps/api/test/pr-drift.spec.ts` (29 cases): which GitHub and
GitLab deliveries start a check (actions, drafts, forks, `update` without
`oldrev`), the signature and token checks, the deepest-module tie and the hub
rule, a markdown page the change edits being excluded, subdir scoping, file
mentions (with generic filenames refused), diff excerpts, what a verdict must
carry, and the comment's escaping.

End to end, against the public `hrustalq/knowledge` repository and its PR #58:

1. Signed `pull_request` deliveries to the per-connector hook: `opened` queues
   one sentinel run; the same head again queues nothing; a new head (GitHub
   signature or GitLab token) is absorbed into the pending run; `edited` queues
   nothing; a bad signature is a 401.
2. The worker read the real diff (8 files) from GitHub. With a page in the
   connector's project stating the pre-#58 behaviour and naming
   `apps/api/src/common/frontmatter.ts`, the run tied it as *mentioned*, judged
   it drifted on both statements the PR changed, and drafted the corrected page
   — one model call, three seconds.
3. Propose opened a merge request from that draft with no model call; the
   proposed revision kept the page's frontmatter, and the description links the
   pull request. A second Propose is a 409.
4. With the connector's mode set back to `off` before the run finished, the
   sweeper claimed the run and published nothing.

Not exercised end to end: posting the comment to a real pull request, which
needs a repository and token to write to.
