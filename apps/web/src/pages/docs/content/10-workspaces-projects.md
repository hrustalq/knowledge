---
title: Workspaces and projects
section: Concepts
summary: The tenancy boundary, the folder that is only a folder, and why one of them is invisible to the graph.
---

# Workspaces and projects

## Workspace — the boundary

A workspace is the tenant. It owns members, roles and everything they can reach, and it
is the predicate on every read that touches shared infrastructure:

- **Storage keys** start with it: `workspaces/{ws}/documents/{doc}/revisions/{rev}/source.md`.
- **Graph queries** carry it, always. Every read goes through one service so the predicate
  has a single injection point — including the operator escape hatch, where an arbitrary
  query is wrapped in an outer `SELECT` that applies the workspace filter and drops any
  row that cannot prove which workspace it belongs to.
- **ACLs** live here: membership grants exactly one role per workspace.

| Role     | Can                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| `viewer` | read pages, search, comment on any page they can read                                                              |
| `editor` | everything above, plus create, edit, import, move and open merge requests                                          |
| `admin`  | everything above, plus manage members, delete projects, configure AI and connectors, merge into protected branches |

Two flags sit beside the roles. `trusted_operator` unlocks raw graph queries (audited, row
capped, single `SELECT` only). `is_admin` on the user is a _platform_ admin: it bypasses
workspace ACLs entirely and gates the account-management routes.

Membership is per workspace, so the same person can be an admin in one and a viewer in
another. Creating a workspace makes you its admin and its operator.

## Project — the folder

A project groups pages for people. It has no members, no roles and no permissions of its
own: authorization resolves a project id to its owning workspace and checks the role
there, which is why a project id from another tenant returns 403 rather than leaking a
name.

Every document belongs to exactly one project — the column is `NOT NULL` with a real
foreign key. That has two consequences worth knowing:

- **A workspace always keeps at least one project.** Deleting the last one is refused,
  because the next page created would have nowhere to go.
- **Deleting a project is move-then-delete.** Pages are never deleted anywhere in this
  product, so a project that holds anything cannot simply vanish: name a destination
  (`DELETE /v1/projects/:id?moveContentsTo=…`) and its documents, glossary terms,
  connectors, workflows and imports in flight are reassigned there in one transaction
  before the emptied project is dropped. Without a destination the call is refused
  (409, `reason: 'not-empty'`) and carries the full holding, so you can see what is in
  the way. These are the rules ACLs cannot express, so they live in the service rather
  than in a guard.

`GET /v1/projects/:id/deletion-preview` answers what a deletion would relocate, and
`?target=` adds the one thing that depends on the pair: terms both projects define. A
project defines each term once, so those cannot both survive — the destination keeps its
definition and the departing project's copy is dropped. The delete dialog shows this
before you confirm.

### Deleting the contents instead

`DELETE /v1/projects/:id?mode=cascade&confirm=<the project's name>` is the other option,
and the only operation anywhere in the product that removes a page. It destroys the
project's documents along with everything downstream of them — every revision, the files
in object storage, attachments, merge requests, review and page discussions, workflow
runs, graph vertices and search index entries. There is no undo, nothing is archived, and
the bytes are removed rather than hidden behind a version marker.

Because of that it is gated twice: the dialog never preselects it and asks you to type the
project's name, and the API checks that name again server-side — a client is not where an
irreversible act gets confirmed. The preview reports what a cascade would destroy
(`cascade` in its response) next to what a move would relocate, so both prices are visible
before either is paid.

Moving a page between projects moves **its whole subtree**. A page nested under it stays
nested under it; the moved page itself is re-rooted in the target project unless the same
call names a new parent there.

## Why the graph does not know about projects

The graph models semantic facts — _this service depends on that queue_, _this page
describes that entity_. A project is a UI decision someone made on a Tuesday. Putting it
in the graph would mean every relation query had to reason about a grouping that carries
no meaning, and reorganizing folders would appear to change what is true.

So the graph has no `Project` vertex and no edge to one. Filtering search results by
project happens afterwards, against Postgres, over an over-fetched candidate set — the
same way category filtering works.

## Switching scope in the app

The workspace and project pickers sit at the top of the sidebar. Both persist in cookies
(`kn_ws`, `kn_proj`) so the server-rendered pass already knows which scope you are in
rather than flashing the wrong one. Changing the project re-scopes the page tree, the
glossary, the workflow roster and the search default in one move.

Manage projects at [Settings → Projects](/settings/projects), members at
[Settings → Access](/settings/access).
