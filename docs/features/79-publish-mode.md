# 79 — Publish mode: direct or review, history audience, approvals per workspace

Milestone [#958](https://github.com/hrustalq/knowledge/issues/958), phases
[#959](https://github.com/hrustalq/knowledge/issues/959) (the policy),
[#960](https://github.com/hrustalq/knowledge/issues/960) (approvals, the Editing page),
[#961](https://github.com/hrustalq/knowledge/issues/961) (direct mode in the editor),
[#962](https://github.com/hrustalq/knowledge/issues/962) (MCP),
[#963](https://github.com/hrustalq/knowledge/issues/963) (Proposals),
[#964](https://github.com/hrustalq/knowledge/issues/964) (history audience),
[#965](https://github.com/hrustalq/knowledge/issues/965) (the refusal). It builds on
[66 — Drafts and publishing](66-drafts-publishing.md), which is now the `review` mode, and
[78 — MCP toolsets](78-mcp-toolsets.md).

## What

A person who runs a workspace alone, with their own agents connected over MCP, had to go
through a working branch and a merge request to change a page, with nobody to review it.
A team that wanted review could not have it either: the review path was a habit of the
editor, and any editor could write to a published page over REST or MCP.

The rule now: **the revision history is always on; a workspace chooses the path a person's
edit takes to the default branch, as one resolved policy read at the point of the write.
Anything a person did not write (an agent finding, a capture, a connector proposal) stays
a merge request in every mode.**

```
workspace_settings.publish_mode / history_audience / required_approvals   (null = inherit)
  → EditingPolicyService.policy(workspaceId)        one resolved answer, cached 30 s
      → DocumentsService.assertMayWrite             every new revision
      → MergeRequestsService.gates                  the approvals number
      → PermissionService.requireHistory            every history read
      → McpService.whoami → instructions, skill     what an agent is told
      → GET /v1/workspaces/:id/editing-policy       what the web app draws
```

## The policy

Three nullable columns on `workspace_settings`, resolved by `EditingPolicyService`
(`apps/api/src/auth/editing-policy.service.ts`, in `AuthCoreModule`, so the API, the
worker and the MCP server read the same one):

| Setting | Values | Null means |
| --- | --- | --- |
| `publish_mode` | `review` \| `direct` (`PUBLISH_MODES`) | `review` |
| `history_audience` | `everyone` \| `editors` (`HISTORY_AUDIENCES`) | `everyone` |
| `required_approvals` | 0–20 | `MR_REQUIRED_APPROVALS` |

`GET /v1/workspaces/:id/editing-policy` answers every member, guests included: the web
app needs the mode before its first render. Each setting comes back as a `ScopedSetting`
(what the workspace asked for, what applies, and the level that decided), and
`requiredApprovalsDefault` carries the env number a cleared field returns to. The
`project` slot is always null: there is no project override yet.

`PUT` takes a workspace admin. A key left out is unchanged, `null` goes back to
inheriting, an unknown value is a 400, and each write is an audit row
(`workspace.editing_policy_updated`). A stored value a later release drops from its
vocabulary reads as unset.

`MR_REQUIRED_APPROVALS` is a **default** here, not a ceiling: a workspace may set a higher
or a lower number than the server's.

## The two modes

| Surface | `review` (default) | `direct` |
| --- | --- | --- |
| Editor, a published page | the author's working branch, Save draft and Publish through a merge request ([66](66-drafts-publishing.md)) | the default branch, one action, live at once, no branch and no merge request row |
| REST `POST :id/revisions`, `POST :id/uploads` with no branch | 409 `review-required` unless the caller is a workspace admin | any editor |
| MCP `knowledge_create_revision`, `knowledge_patch_document`, `knowledge_start_upload` with no branch | the same 409 | any editor |
| `git push` to the default branch | refused (`review required`) unless a workspace admin | any editor |
| A merge, a connector sync, a source-backed sync, a scaffold, a proposal | writes | writes |
| A new page | a private draft until its author publishes it | the same |
| Agent findings, captures, connector proposals | merge requests | merge requests, listed under **Proposals** |

### The refusal

`DocumentsService.assertMayWrite` runs inside `createDraftRevision`, the one place every
revision is created, beside the source-backed rule. It refuses a **person's** write to the
**default branch** of a **published** page in a `review` workspace unless that person is a
workspace admin (`AccessScope.bypass`). The body is a 409 with `reason: 'review-required'`
and no page title.

Every revision writer takes a required `WriteAuthority`
(`apps/api/src/documents/write-authority.ts`), so a new caller cannot reach a default
branch by leaving the argument out:

- `{ person: principal }` is a person's direct edit, held to the mode. The REST
  controller, the MCP authoring tools and a direct git push pass this.
- `internalWrite('merge' | 'connector-sync' | 'proposal')` names a write with its own
  authority, greppable as `systemScope` is for reads. A merge is the review path itself;
  a connector writes its own synced or source-backed page; a proposal writes a branch a
  merge request then carries.

Never held: a branch other than the default; a private draft page (`draft_owner_id`), its
author's until Publish; the first revision of a page that has none. A page still behind
its merge request (`pending_merge_request_id`) is held, because its first revision is that
merge. The dev principal and the principal-less stdio MCP server pass, as they pass every
other check.

A git push asks the same predicate before anything is written
(`GitPushService.assertMayGoDirect` → `DocumentsService.assertMayWriteDirect`), and keeps
its `protected` check. A push that lands a merge request writes as `internalWrite('merge')`.

### The editor

`workingBranchAsk` (`apps/web/src/modules/editor/model/working-branch.ts`) is the editor's
whole decision: a `?branch=` link names its branch; a private draft page has none; in
`review` the working branch is asked for and created (`POST :id/branches/mine`); in
`direct` only a working branch that already holds unpublished work is used
(`GET :id/branches/mine`, which creates nothing), so switching the mode strands nobody's
draft. Otherwise the default branch is edited, and a save over a head that moved is the
existing 409 with its comparison link.

The spec and fixture editors save through the same working branch and Publish when the
workspace reviews changes and the author is not an admin
(`apps/web/src/modules/api-reference/model/save-structured.ts`).

### MCP

`knowledge_whoami` reports each workspace's `publishMode`. `authoringOf`
(`apps/api/src/mcp/mcp-tools.ts`) folds the workspaces a connection reaches into
`direct` (every one is), `review` (none is) or `mixed`, and the server instructions and
the authoring section of the skill are composed from it: one revision on the default
branch, the branch → revision → merge request path (byte for byte what it was), or both
with the rule that the workspace decides. Captures are described the same in every mode.
The merge-request tools stay offered in `direct` mode: agent and capture proposals use them.

### Proposals

In a `direct` workspace the nav and the page say **Proposals** where they said Merge
requests. It is the same route (`/merge-requests`), list, cards and merge controls, with
`provenance=not-manual` as its base scope, so the tab counts count proposals only. A merge
request a person opened anyway (a named branch, a git push, an MCP call) is reachable by
its link and from its page. Accepting a proposal is the existing merge.

## Approvals

`MergeRequestsService.gates` reads the workspace's resolved number. It is still not asked
of the dev principal or a call with no principal ([05](../architecture/05-merge-review.md)).
The merge widget shows how many are required.

## History audience

With `history_audience: editors`, a caller below editor on a page reads the current page,
its current facts and relations, and is refused its history with a 403
`reason: 'history-restricted'`, the same answer on every surface:

| Surface | What is refused |
| --- | --- |
| `GET :id/revisions`, `GET :id/branches`, `GET :id/facts/timeline` | always (`@History()`) |
| `GET :id/compare`, `GET :id/facts?at=` | always: they name revisions |
| `GET :id`, `GET :id/content`, the `.md` route, the API spec reads | with a `revision` / `revisionId` that is not the current head |
| any route that takes `asOf` / `knownAt` (page content, the page and workspace graphs, entities, impact) | when either is given |
| search with `asOf` / `knownAt` (REST, MCP, the assistant) | refused inside `SearchService` |
| MCP `knowledge_list_revisions`, `knowledge_compare_revisions`, `knowledge_get_historical_context`, `knowledge_diff_api_spec`, the graph tools with `asOf` | `guard.history` |
| MCP `knowledge_get_document`, `knowledge_get_document_content`, `knowledge_get_embed`, `knowledge_get_test_fixture` | with a `revisionId` that is not the current head |

`PermissionService.requireHistory` is the one predicate. It takes edit on the page; for a
read that spans the workspace (an as-of search or graph) it takes the editor role. A
read-only key reads as a viewer, as everywhere. Naming the current head is not history,
and neither is the head of a branch a merge request was opened from: a proposal's diff is
not page history, and whoever may read the merge request reads it.

On REST the guard decides by what the request asks for (`AclGuard.requireHistory`): a
route marked `@History()`, any `asOf` / `knownAt` in the query or body, and a GET on a
page that names a revision through `BRANCH_REFS`. A new route that names a revision
through one of those keys is covered as it lands. `apps/api/test/history-audience.spec.ts`
fails when a controller reads a revision or a point in time through a key the guard does
not know, and when an MCP read tool takes one without calling `guard.history`.

The page view draws no History widget for a reader, and asks for no revision list. The
activity feed carries no diff links, so nothing changed there.

## Routes

| Route | Role | |
| --- | --- | --- |
| `GET /v1/workspaces/:id/editing-policy` | viewer, guests too | the resolved policy |
| `PUT /v1/workspaces/:id/editing-policy` | admin | set, or null to inherit |
| `GET /v1/documents/:id/branches/mine` | editor | the caller's working branch if it holds unpublished work, else null |
| `GET /v1/merge-requests?provenance=not-manual` | viewer | every merge request a person did not open |

## Limits

- **Workspace only.** A project override can follow as a nullable column on `projects`
  ([76](76-project-settings.md)); the `project` slot of each `ScopedSetting` is there for it.
- **Admin is the only exception in `review` mode.** There is no per-person or per-group
  direct-push permission, and nothing sets a branch `protected`.
- **Restoring a revision** of an ordinary page writes to its default branch, so in a
  `review` workspace it is an admin's act.
- **A direct save does not 3-way merge.** Two people saving the same page in `direct` mode:
  the second gets the head-moved notice and compares.
- **The structured editors have no "publish on top".** A spec or fixture whose working
  branch the page moved past is refused with the API's message.
- **History on published sites and share links is untouched**: they serve a snapshot or
  the head already.
- **Merge request diffs stay readable** to whoever can read the merge request, in both
  history settings.
- **The mode is not chosen by the workspace-purpose interview** ([77](77-workspace-purpose.md)).
