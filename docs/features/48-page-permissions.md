# 48 — Page permissions

Issue [#76](https://github.com/hrustalq/knowledge/issues/76), shipped as seven
PRs (#196–#201 and the hardening PR). Before it, the workspace was the only
access boundary: a `viewer` could read every page in it, and so could every
assistant turn, agent run and MCP client acting as that person. HR, security,
legal and customer content either went into a separate workspace, which cut it
off from search, the graph and cross-links, or stayed out of the product.

Now a page or a project can be **restricted** to named people and groups. For an
AI-first knowledge base the retrieval half matters more than the dialog: search,
the graph walk, the assistant, agents, chat bots and MCP see exactly what the
person behind them may open, or the restriction is theatre.

This document is the product layer. The mechanics live in the architecture docs:
the predicate and the guard in [06 §Page restrictions](../architecture/06-auth-acl.md#page-restrictions),
retrieval in [04 §Page restrictions](../architecture/04-search-graph.md#page-restrictions),
live events in [08 §Access control, then tracking](../architecture/08-events-live.md#access-control-then-tracking),
and connector mirroring in [19 §Access mirroring](19-connectors.md#access-mirroring-76-phase-6).

## The model

- **Unrestricted is the default.** A page or project with no restriction behaves
  exactly as before the milestone. An empty `access_grants` table reproduces the
  old behaviour, and the existing test suites run unchanged.
- **Three levels**, granted to a person or a group: `view`, `edit`, `manage`
  (change the restriction, decide access requests).
- **View is intersective down the tree.** A reader must pass every restricted
  node on the chain project → root page → … → page. Restricting a page hides its
  whole subtree. A child can narrow its parent's restriction but never reopen
  it. A page moved under a restricted parent is restricted in the same
  transaction, and moving it out lifts that at once.
- **The workspace role is the ceiling.** A `viewer` with an `edit` grant still
  only reads. Edit is decided by the nearest restricted node that carries any
  edit or manage grant; with none, an `editor` edits as before.
- **Guests** (`workspace_members.role = 'guest'`) see nothing except the pages
  and projects granted to them or their groups, and whatever lies under those.
  They can edit only where granted `edit`. They are refused workspace-level
  routes: settings, connectors, groups, AI settings.
- **Admins bypass.** Workspace admins and platform admins see and edit
  everything, because they control membership anyway. Each time an admin opens a
  restricted page no grant admits them to, an `acl.bypass` row is written to
  `audit_logs` (at most once a minute per admin and page).
- **API keys only narrow.** A read-only key caps every level at `view`.

## Private drafts

Issue [#474](https://github.com/hrustalq/knowledge/issues/474), phase 1. A page
a person creates (the editor, `POST /v1/documents`, MCP
`knowledge_create_document`) starts as a **private draft**: a restricted page
whose author holds `manage`, plus `documents.draft_owner_id`, which tells it
apart from a page restricted on purpose. Nothing else is new: every surface in
the table below already hides a restricted page, so a draft is hidden from
search, the graph, the assistant, notifications, activity, share links, sites,
`llms.txt` and export by the code that was there. Admins still bypass and are
audited.

- **Opting out.** `visibility: 'workspace'` on the DTO or the MCP tool creates
  the page open, as before #474. Unset means `private` only at those two doors;
  `DocumentsService.createDocument` treats unset as `workspace`, so imports,
  connector pulls, workflows, the repo wiki, agents and captures are unchanged.
- **Sharing** is the Access dialog: the draft's grants are who it is shared
  with. The restricted switch is not offered on a draft, and the PUT refuses
  `restricted: false` with 409 `access.draftPublishFirst`.
- **Publish** (`POST /v1/documents/:id/publish`, manage on the page) clears the
  marker and the restriction, drops the draft's manual grants and recomputes
  `restricted_by`, in one transaction guarded on the marker, so a second call is
  a no-op. Then `acl.changed` and `document.published`, which reaches the page's
  and the project's watchers (creation reached nobody they could read).
- **Children** inherit as always: anything under a draft is hidden until it is
  published, and a private child stays private after its parent is published.
- Creating a draft publishes `acl.changed` before the page's first event, since
  no cached scope has the new node in its `denied` set yet.

### Private branches (phase 2a)

`document_branches.owner_id` + `restricted`, and `access_grants` rows with
`resource_type = 'branch'` at `view` or `edit`. A branch is not a node in the
page chain: the page level is decided first (`levelOn`), and
`branchLevel` (`permissions/branch-access.ts`, one in-memory spelling — a page
has a handful of branches) only narrows it. An open branch adds nothing; its
owner and admins edit it; anyone else holds what their or their groups'
grants on it say; a read-only key caps it at view.

- **Where it is enforced.** `AclGuard`, after the page check on every
  `'document'` route, reads the request's branch refs (`BRANCH_REFS`: `:branchId`,
  `:revisionId`, `?branch`, `?revision`, `?from`, `?to`, `?at`, body `branch`,
  `sourceBranch`, `targetBranch`, `revisionId`, `fromRevisionId`) and holds each
  to the route's level (`PermissionService.requireBranches`). A new route that
  names a branch through one of those keys is covered as it lands; a new key
  must be added there. MCP tools call `guard.branches` after `guard.doc`. The
  collab gateway checks the branch on join and on every re-check.
- **Lists** (branches, revisions, collab drafts) filter by
  `visibleBranchIds`.
- **Silence.** A revision on a private branch records no activity row and
  publishes no `revision.finalized`, `revision.indexed` or `revision.failed`,
  so the feed, live frames, watcher notifications and workflow triggers never
  hear of it; creating one records no `branch.created`. Its chunks are indexed
  but never `live`, as for any non-default branch.
- **Export and sites** never resolve a private branch by name: the page
  falls back to its default branch.
- **Refusal.** A member gets 403 `{ resourceType: 'branch', resourceId,
  canRequestAccess: false }` (a branch is shared by its owner, not requested);
  a guest 404. An admin let in only by the bypass is audited (`acl.bypass`,
  `resourceType: 'branch'`).
- **Opening a merge request** from (or into) a private branch clears its
  `restricted`: the MR is read by everyone who can read the page.

Phase 2b puts the editor on these branches: each person edits a published page
on a private working branch (`POST /v1/documents/:id/branches/mine`) and
**Publish** merges it through a merge request. What the author does and what
each step writes is [66 — Drafts and publishing](66-drafts-publishing.md).

## Groups

Workspace-scoped sets of people (`user_groups`, `user_group_members`), managed
under **Settings → Access → Groups** by workspace admins. A group's
`source` is `manual`, `connector` (mirrored from a source, read-only here) or
`scim` (reserved for enterprise provisioning). Deleting a group deletes the
grants made to it. Leaving a workspace removes a person's group memberships and
grants, so a re-added person or a reused id inherits nothing.

## Where people meet it

- **Access dialog** (`components/access/PageAccessDialog.vue`), from the page
  header and the tree row menu. It has the restricted switch, a person/group
  picker with a level per grantee, and the inherited chain shown read-only
  ("Restricted by *Parent* · 3 people"). Grants a connector mirrored appear with
  a source badge and cannot be edited. **Who can see this**
  (`EffectiveAccess.vue`) expands groups into people, each with the node that
  admits them. Only managers see it.
- **Lock icons** on restricted rows in the sidebar and the document tree.
- **Breadcrumbs.** An ancestor the reader cannot open (only possible for a guest
  granted a page below it) keeps its id and nothing else: an empty title and
  `hidden: true`.
- **A refused page** answers a member `403 { canRequestAccess, resourceType,
  resourceId }`, never the title, and the page shows **Request access**
  (`RequestAccessCard.vue`). Guests and non-members get a 404, which confirms
  nothing.
- **Project restriction** on the project page, for workspace admins.
- **Mentions.** Mentioning someone who cannot open the page notifies nobody. The
  thread response lists them in `mentionedWithoutAccess`, and the editor offers
  the Access dialog.

## Access requests

A member refused a page can ask for it with a level and a note. The request goes
to the managers of the restricted nodes on the chain, plus the workspace admins,
and shows in **Settings → Access → Requests**. Approving grants the
decided level on **every** restricted node on the chain that the requester
lacked a grant on, because view is intersective: a grant on the page alone would
open nothing under a restricted parent. Approve, deny and cancel each notify.
There is one pending request per person and node (a second answers 409), and
pending requests expire after `ACCESS_REQUEST_TTL_DAYS`.

## What a restriction reaches

| Surface | Behaviour |
| --- | --- |
| REST | The guard checks the page behind `document`, `merge-request` and `project` routes. Lists, the tree, breadcrumbs, project overviews, entity views, the knowledge-health dashboard and profiles take the caller's scope. |
| Search | All three legs (vector, BM25, graph expansion). PG has the final say; the stores get a deny or allow list as a prefilter. Results still fill `limit` when enough visible pages match. |
| Graph | Hidden pages' edges are dropped, then every entity only those edges named, so a restricted page cannot leak an entity name. |
| Assistant | The scope is read **on every tool call**, so revoking access mid-turn applies to the next call. A hidden page reads as "not found" to the model. Write tools need `edit`. |
| Agents, workflows, chat bots | Output posted where others read it uses the **audience clamp**: a source page is usable only if everyone who can read the destination could read it too ([06 §The audience clamp](../architecture/06-auth-acl.md#the-audience-clamp)). |
| MCP | Same guard per page. `knowledge_search`, the tree and project tools are scoped, and guests may use them. New tools are `knowledge_get_page_access` (read) and `knowledge_request_access` (write; hidden from read-only keys). |
| Notifications, activity, live events | Delivered or listed only for people who can open the page. Live connections get `acl.changed`, which names no page, after any grant, restriction or group change, and refetch. |
| Share links, published sites, llms.txt, export | A restricted page cannot be shared publicly, and an existing link to it 404s. It is left out of site snapshots and of the workspace and project `llms.txt`. An export holds only what the requester may open. |
| Connectors | With mirroring on, a page private at the source arrives restricted the same way. See [19 §Access mirroring](19-connectors.md#access-mirroring-76-phase-6). |
| Connected repositories | A repository follows its connector's project (#553, `canSeeProject`): the assistant's repository list, `code_*` and the work-item tools treat one in a project the caller cannot open as not found, checked on every call. Agent runs are clamped, so none reads a restricted project's repository. The connector routes follow it too (#555): the list (REST and `knowledge_list_connectors`) drops such a connector, and its id and run routes answer 404. |

## API

| Route | Who |
| --- | --- |
| `GET /v1/groups?workspaceId=` · `GET /v1/groups/:id/members` | members |
| `POST /v1/groups` · `PATCH`/`DELETE /v1/groups/:id` · `PUT /v1/groups/:id/members` | workspace admin; 409 on a non-manual group |
| `GET /v1/documents/:id/access` | anyone who can open the page; grants only for managers |
| `PUT /v1/documents/:id/access` `{ restricted, grants }` | manage on the page; replaces its manual grants; 409 `access.selfLockout` if it would leave a non-admin caller without manage |
| `GET /v1/documents/:id/access/effective` | manage |
| `POST /v1/documents/:id/publish` | manage on the page; opens a private draft (#474), no-op on a published page |
| `GET /v1/documents/:id/branches/:branchId/access` | readers of the branch; grants listed for its owner and admins (#474) |
| `PUT /v1/documents/:id/branches/:branchId/access` `{ grants }` | the branch's owner or an admin; view/edit grants only |
| `GET`/`PUT /v1/projects/:id/access`, `…/access/effective` | the same, for a project |
| `POST /v1/access-requests` · `GET /v1/access-requests?workspaceId=&status=&mine=` | members and guests |
| `POST /v1/access-requests/:id/approve` · `…/deny` | manage on every node the approval grants on |
| `POST /v1/access-requests/:id/cancel` | the requester |
| `GET`/`PUT /v1/connectors/:id/acl`, `PUT …/acl/identities/:identityId`, `POST …/acl/sync` | workspace admin |

`PATCH /v1/workspaces/:id/members` accepts `role: 'guest'`.

## Data

`access_grants` (resource, subject, level, `origin` = `manual | connector`),
`access_requests`, `user_groups`, `user_group_members` and
`external_identities`, with no FK on subject or workspace ids (house policy).
On `documents`: `restricted`, `restricted_by` (the ids of every restricted node
on the chain, GIN-indexed, written only by
`PermissionService.recomputeRestrictedBy`), and `acl_version` /
`acl_stamped_version`, which the worker's re-stamp sweeper closes, and
`draft_owner_id` (#474: set on a private draft, cleared by publish). On
`projects`: `restricted`. Every migration is additive and defaults to
"nothing restricted".

## Configuration

All have defaults. None needs setting to use the feature.

| Var | Default | Meaning |
| --- | --- | --- |
| `ACL_CACHE_TTL_MS` | `5000` | Per-connection scope cache for SSE/WS |
| `SEARCH_ACL_OVERFETCH` | `5` | Candidate multiplier when a store could not take the list |
| `SEARCH_ACL_MAX_FETCH` | `500` | Cap for the refill round |
| `ACL_DENY_LIST_MAX` | `5000` | Past this many ids, stores filter in memory instead of in the query |
| `ACL_RESTAMP_TICK_MS` | `30000` | Re-stamp sweeper tick (worker) |
| `ACL_RESTAMP_BATCH` | `200` | Pages re-stamped per tick |
| `ACCESS_REQUEST_TTL_DAYS` | `30` | Pending requests expire |
| `CONNECTOR_ACL_SYNC_DEFAULT_MIN` | `60` | Default interval of a connector's permissions-only refresh |

## Verification

- Unit specs cover the predicate in its three spellings (`permissions.spec.ts`),
  groups, search and graph filtering, the re-stamp, the audience clamp, the
  assistant, notifications, live events, access requests, connector mirroring
  and MCP (`mcp-http.spec.ts`).
- **`apps/api/test/page-permissions.e2e-spec.ts`** runs against live infra with
  `AUTH_MODE=api-key` and four real people (admin, two editors, a guest) in a
  workspace of its own. It covers the 403/404 shapes with no title in the body
  on every per-page route, the tree, list and breadcrumbs, a move under and out
  of a restricted parent, the admin bypass audit row, search in all three modes,
  the re-stamp, the activity feed, MCP search and reads, connector mirroring
  through the real `ConnectorAclService` with a stand-in adapter, and an access
  request from 409 to approval.
  `pnpm --filter @knowledge/api run test:e2e -- page-permissions`.
- `make backtest ARGS="--generate --as <userId>"` measures known-item recall
  through one person's scope, leaving out the pages they cannot open. On the
  demo workspace (487 pages, 3 restricted, the first 30 asked), the unfiltered
  run, a member nothing is hidden from and a member with 3 pages hidden all
  scored the same: recall@1 63.3%, recall@10 76.7%, MRR@10 0.6728. The first
  run of it found that they did not, which was the deleted-page bug in
  [04 §Page restrictions](../architecture/04-search-graph.md#page-restrictions).

## Limits

- **Members learn that a page exists.** A refused member gets a 403 so they can
  ask for access, which is the Confluence trade-off. There is no "hidden" flag
  that would make it a 404.
- **Admins cannot be kept out.** A workspace that wants HR pages hidden even
  from its admins has no setting for it. Admin reads are audited.
- **The audience clamp is conservative.** Two pages restricted to the same
  people through different nodes still exclude each other, so in a mostly
  restricted workspace agent runs and group chat answers see little.
- **No retroactive redaction.** Threads, agent findings and chat messages that
  quoted a page before it was restricted keep the quote.
- **Mapping by email** for mirrored identities is only as good as email
  verification here. Confluence space permissions are not mirrored, and Notion
  pages can only be restricted to one connector-wide group
  ([19](19-connectors.md#access-mirroring-76-phase-6)).
- **Out of scope:** block- or section-level permissions, per-merge-request
  permissions (a private branch, #474, stops being private when an MR is opened), SCIM or SSO group claims (the `source` column is ready
  for them), Jira issue security, and field-level ACLs on glossary, workflows
  and AI settings, which stay gated by workspace role.
