# 76 — Project settings: what a project decides for itself

Milestone [#919](https://github.com/hrustalq/knowledge/issues/919), phases
[#920](https://github.com/hrustalq/knowledge/issues/920) (maintainer guard, setting shape),
[#921](https://github.com/hrustalq/knowledge/issues/921) (freshness thresholds),
[#922](https://github.com/hrustalq/knowledge/issues/922) (breaking-API gate),
[#923](https://github.com/hrustalq/knowledge/issues/923) (handoff rules),
[#924](https://github.com/hrustalq/knowledge/issues/924) (capture parent),
[#925](https://github.com/hrustalq/knowledge/issues/925) (test environments),
[#926](https://github.com/hrustalq/knowledge/issues/926) (workspace glossary),
[#927](https://github.com/hrustalq/knowledge/issues/927) (usage by project),
[#928](https://github.com/hrustalq/knowledge/issues/928) (settings page, this doc).

## What

"The project is organizational only" stopped being true one column at a time: a project
already carried a restriction, a lint policy, a styleguide, a tracker route, a site and a git
remote, while the rest of a team's policy was one value per workspace. The rule now, written
down:

> **The workspace owns identity, money, credentials and ceilings. The project owns how one
> team writes, reviews, verifies and ships its pages.**

A project setting is a **sparse override** of the workspace's. Resolution is

```
page (review interval only) → project → workspace → env or code default
```

and `null` at any level means "inherit". A project with no override behaves exactly as it did
before this feature; every column below is nullable and no migration fills one in.

## What a project may override

| Setting | Stored on `projects` | Resolved by | Written by |
| --- | --- | --- | --- |
| Review interval, reminder window, inactivity, empty-page size | `review_interval_days`, `remind_before_days`, `inactive_after_days`, `empty_max_chars` | `VerificationPolicyService.thresholds` | admin or maintainer |
| Breaking-API merge gate | `api_breaking_change_policy` | `scopedApiBreakingChangePolicy` (contracts) | admin |
| Style lint gate (#74) | `lint_policy` | `LintChecksService.policyFor` | admin |
| Tracker handoff rules | `work_item_issues`, `work_item_conflicts`, `work_item_verification` | the candidate SQL of `WorkItemRulesService` | admin or maintainer |
| Capture parent page | `capture_parent_document_id` | `CaptureService.captureParent` | admin or maintainer |

Two things moved the other way or sideways:

- **Glossary terms may belong to the workspace** ([14](14-glossary.md)): `glossary_terms.project_id`
  is nullable, a term with none links in every project, and a project's term of the same name
  replaces it on that project's pages.
- **A test environment may belong to one project** ([62](62-qa-fixtures-runs.md)):
  `api_test_environments.project_id`, null meaning shared.

And two tables only gained attribution: `agent_runs.project_id` and `ai_usage.project_id`
([12](12-ai-settings.md)), so usage can be read per project. Budgets stay per workspace.

## The rules

1. **One response shape.** Every override is reported as `ScopedSetting<T>`
   (`@knowledge/contracts`): `workspace` and `project` are what each level asked for,
   `effective` what applies, `inherited` what would apply without the project's value, and
   `source` which level decided. `scopedSetting(project, workspace, fallback)` builds it. A
   settings page never shows an inherited value as the project's own.
2. **One writer rule.** `PermissionService.requireProjectManage(principal, projectId)` is the
   only spelling of "may this caller write this project's settings": a workspace admin, or a
   workspace **editor holding a `manage` grant** on the project (their own or a group's) — its
   maintainer. Not `requireLevel(…, 'manage')`: on a project nobody manages, `levelOn` gives
   every editor manage so they can restrict an open page, and a setting is not theirs to
   write. The workspace role stays the ceiling (a viewer's grant buys nothing) and a read-only
   or capture key is refused as on any write.
3. **Merge gates are an admin's.** The breaking-API and lint gates are `@Access('admin', …)` at
   both levels. A maintainer may tighten how their team works; loosening what can merge is a
   workspace decision.
4. **Every SQL twin is changed with its code spelling.** The health CTE carries
   `COALESCE(p.inactive_after_days, <workspace>)` per row and the filters read the row; the
   reminder sweep reads `COALESCE(p.remind_before_days, COALESCE(s.remind_before_days, <env>))`;
   the handoff sweep resolves `COALESCE(p.work_item_*, <workspace rule>)` in its candidate
   query, so a project that is `off` never fills a tick's budget. `project-verification.spec.ts`
   and `project-work-item-rules.spec.ts` pin them.
5. **A stored value is a declaration, not a fact.** A capture parent that was deleted, archived
   or moved out of the project is skipped at read time and the next level applies — the
   capture never fails, and the settings row says the project's choice no longer holds.
6. **Changing an interval moves no stored stamp.** `verification_expires_at` is computed when a
   page is verified, as before.

## Handoff rules: `off` is a value

The workspace stores "off" as `null` (one spelling of "nothing happens"). A project cannot,
because `null` there means "inherit" — so a project stores an explicit `off`, which opts it out
while the workspace rule is on. The reverse also works: a project may turn a rule on under a
workspace that has none, and the sweep visits that workspace for that kind alone. Either way a
ticket goes only into the project's tracker route ([32](32-connector-work-items.md)).

## Test environments

`ApiTestEnvironmentsService.usableBy(workspaceId, environmentId, documentId)` is the one rule:
shared, or bound to the project of the suite's document. It is asked when a run is started
(REST and `knowledge_run_test_suite` alike) and **again** when the worker opens the secrets,
so an environment bound elsewhere between the click and the run is refused. A foreign
project's environment is "not found", never named. Sharing a bound environment, or moving it
to another project, lets someone new use its secrets, so such a change keeps only the secrets
the request sets — the rule a new destination host already follows. An environment bound to a
restricted project is listed only to those who may open the project.

## Usage by project

`projectOfRun` (`ai/run-project.ts`) resolves the **one** project a run is about when it
starts: the page it names (subject `doc:`/`mr:`/`issue:`, or its input), else its memo's, else
its connector's. A run naming pages of several projects, or none, stays unattributed — never
split. `AgentExecutor` stamps the row and puts the project in the run context;
`AiUsageService.record` reads it there, else from the page its assistant thread is on. No call
site resolves a project. `GET /v1/ai/usage?groupBy=project` returns one bucket per project and
one `unattributed`, which together equal the total. A failed lookup never fails a model call.

## Surface

| Route | Reads | Writes |
| --- | --- | --- |
| `GET/PATCH /v1/projects/:id/settings/verification` | viewer of the project | admin or maintainer |
| `GET/PATCH /v1/projects/:id/settings/breaking-changes` | viewer | admin |
| `GET/PUT /v1/lint-policy` (with `projectId`) | viewer | admin |
| `GET/PATCH /v1/projects/:id/settings/work-items` | viewer | admin or maintainer |
| `GET/PATCH /v1/projects/:id/settings/capture-parent` (section `captures`) | viewer | admin or maintainer |
| `GET /v1/projects/:id/settings/access` | viewer: `{ canWrite, canWriteGates }` | |
| `GET /v1/projects/setting-overrides?workspaceId=` | viewer: which visible projects override what | |
| `POST /v1/glossary/:id/promote` | | admin |

Each project route is `@Access(…, 'project')`, so the guard resolves the project's workspace in
PostgreSQL and checks the caller may open the project before the handler runs.

**Web.** `/settings/projects/:id/policies` (`ProjectSettingsPage.vue`), linked from the
project's form. Every row states what applies, which level decided it and what the project
would otherwise follow, with a reset. One Save for the page; only changed groups are sent. A
maintainer sees the two gates disabled with the reason. A group whose section is switched off
is absent. Each workspace screen for an overridable setting names the projects that override
it (`ProjectOverridesNote`, `entities/project`).

There are no MCP tools for these settings: they are a person's decisions.

## Operations

Seven migrations, all additive: nullable columns on `projects`, `api_test_environments`,
`agent_runs` and `ai_usage`, and `glossary_terms.project_id` made nullable. The last one
backfills `agent_runs.project_id` and `ai_usage.project_id` in single statements; on a large
`ai_usage` table that is one pass at deploy.

Rolling back the code after the release is used: the previous image ignores every project
override (the workspace value applies again), treats a project-bound test environment as
shared, and does not know a glossary term can have no project.

## Not done

- Memos without a project, per-project feature toggles, per-project budgets, models or
  providers, per-project search knobs. Search spans projects.
- Recomputing stored expiry stamps when an interval changes.
- An audit entry for a project setting write.
