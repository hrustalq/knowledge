# 66 — Drafts and publishing

Issue [#474](https://github.com/hrustalq/knowledge/issues/474). Before this
change, everything a person wrote was visible to the whole workspace as soon as
it existed. A new page was finalized unrestricted. An edit to an existing page
went straight onto its default branch, or into a branch's shared draft that
anyone who could read the page could join. There was no way to work on
something half-finished, show it to one or two people, and publish it when it
was ready.

Now both start private:

- **A new page** is a private draft page (phase 1, [#523]). The page itself is
  restricted to its author until **Publish**.
- **An edit to a published page** happens on the author's private working
  branch (phases 2a [#524] and 2b). **Publish** merges it onto the page through
  the merge-request path.

How the restriction is enforced on every read path (REST, MCP, search, the
graph, the assistant, notifications, live events, export, sites) is
[48 — Page permissions](48-page-permissions.md#private-drafts). This doc covers
what an author does and what each step writes.

[#523]: https://github.com/hrustalq/knowledge/pull/523
[#524]: https://github.com/hrustalq/knowledge/pull/524

## Decisions

Taken with the user before building:

- **Every Publish of an edit leaves a merge request.** Publish opens one from
  the working branch and merges it at once unless a gate refuses. It reuses
  `MergeRequestsService.merge` and every gate it has. The lint gate can only
  judge an MR, so a direct merge would have needed its own exemption. The cost
  is one MR row per published edit, and each one keeps its diff.
- **Merge gates apply**, approvals included. With `MR_REQUIRED_APPROVALS ≥ 1`
  (the default), a non-admin's Publish waits for a reviewer. Before this, the
  editor wrote straight to the default branch and asked nobody. Set it to `0`
  to keep direct publishing.
- **Someone a branch is shared with at view reads it on the page view**, at
  `/documents/:id?branch=<name>`. The share notification links there.

## A new page

See [48](48-page-permissions.md#private-drafts). The editor's button reads
**Save draft**. The page header has **Draft · private**, which opens the Access
dialog, and **Publish**.

## An edit to a published page

### The working branch

`POST /v1/documents/:id/branches/mine` (`DocumentsService.myDraftBranch`,
editor role) returns the caller's working branch for the page. It creates the
branch on the first call.

- **Name.** `draft/<userId>`, then `draft/<userId>-<n>`.
  `DRAFT_BRANCH_PREFIX` (`@knowledge/contracts`) is the one spelling, and both
  the API and the editor read it.
- **Private** (`restricted`, `owner_id` = the caller), so the branch rules of
  phase 2a apply: only the owner, the people they share it with, and admins can
  read it or its revisions, and nothing on it reaches the feed, live frames,
  notifications or search.
- **Spent** once a merge request from it is merged or closed, because opening
  the MR made it readable. The next call starts the next `-<n>`. An open MR
  keeps the branch current, so further saves update the MR under review.
- **Follows the default head** while nothing has been written on it: no
  revision of its own and no shared draft. Otherwise an editor opened a week
  later would load the page as it read the day the branch was cut.

### The editor

`EditorPage.vue`, on a published page with no `?branch=`, calls `mine` while it
loads and edits that branch. A `?branch=` link edits the branch it names (how a
person the branch was shared with at edit joins it). A private draft page
edits its default branch, since the page itself is private already.

- **The bar** says **Your draft · private**. Once an MR is open, it says
  **Your draft · in review**.
- **Save draft** writes a revision on the branch and stays in the editor. The
  body and its frontmatter are in the revision. The page fields (title,
  category, parent, project) are not versioned, so they stay unstaged until
  Publish.
- **Publish** saves whatever is unsaved, then calls `publish`, then PATCHes the
  page fields. If it merged, the editor goes to the page. If a gate held it,
  the editor goes to the merge request, with a toast that names the gate.
- **Share** (the branch's owner or an admin) opens the Access dialog in branch
  mode (`PageAccessDialog` with `branch-id`). It shows the same grant list at
  view or edit, with no switch and no inheritance.
- **The working copy** of the caller's own branch keeps the page's default
  slot. There is one working branch at a time per person and page, so edits
  stored before #474 are offered back, and the page view's unstaged dot still
  finds them. Someone else's branch opened by `?branch=` has its own slot, as
  any named branch does.
- **With `COLLAB_ENABLED`** the working branch has its own shared draft
  ([56](56-realtime-coediting.md)). The people it is shared with at edit join
  that draft. Save draft publishes from the draft as a branch publish always
  has.

### Publish

`POST /v1/documents/:id/branches/:branchId/publish` `{ title, onTopOf? }`
(`MergeRequestsService.publishBranch`). The guard holds the caller to edit on
the branch (`:branchId` is one of `BRANCH_REFS`).

1. **Refused before anything opens.** These checks come first so that a
   refused publish never creates an MR, which would make the branch readable:
   - the default branch itself → 400 `branch.publishDefault`;
   - nothing to publish (the branch head is already in the default head's
     history) → 400 `nothingToMerge`;
   - the default head moved past the branch and `onTopOf` does not name it →
     409 `diverged` with `currentHeadRevisionId` and a comparison link (the
     same body `merge` sends).
2. **The merge request.** The open one from this branch into the default
   branch is reused; otherwise one is created. Creating it clears the branch's
   `restricted`.
3. **The merge**, as `merge-commit`. `onTopOf` lets it land over the head the
   author reviewed, and over no other: their content wins, as **Publish on
   top** does for a shared draft. A protected default branch and a caller who
   is not an admin is answered before `merge` is called. A 409 `approvals`,
   `lint`, `breaking-api` or `draft` from `merge` becomes a held answer.

The response is `PublishBranchResponse`: the MR, the merged revision or null,
`merged`, and `reason` (`protected` | `approvals` | `lint` | `breaking-api` |
`draft` | null).

**Diverged, in the editor.** A notice says the page was published since the
draft began. **Review changes** opens the editor's review dialog on
`compare?from=<default head>&to=<branch head>&mode=direct`. **Publish over it**
publishes again with `onTopOf`.

**Who hears about it.** The merge records `merge-request.created` and
`merge-request.merged`, and the merge revision is an ordinary
`revision.finalized` on the default branch. Watchers hear about the edit when
it is published, never while it is drafted.

### Reading a shared branch

`/documents/:id?branch=<name>` reads the branch head as the page view reads
any older revision: read-only, with no comments, and with the verification
stamp left to the head. A line above the page names whose draft it is, and has
**Open in editor** (for editors) and **Published page**. The `access.granted`
notification for a branch links here (`notificationLink`).

## Routes

| Route | Who | Does |
| --- | --- | --- |
| `POST /v1/documents/:id/branches/mine` | editor on the page | The caller's working branch, created on first ask |
| `POST /v1/documents/:id/branches/:branchId/publish` `{ title, onTopOf? }` | editor on the page, edit on the branch | Opens or reuses the MR and merges it, or holds it behind a gate |
| `GET`/`PUT /v1/documents/:id/branches/:branchId/access` | [48](48-page-permissions.md) | Who the branch is shared with |
| `POST /v1/documents/:id/publish` | manage on the page | Publishes a private draft page (phase 1) |

There is no MCP tool for either publish yet. An agent changes a page through
`knowledge_create_branch` → `knowledge_create_revision` →
`knowledge_create_merge_request`, as before.

## Limits

- **Page fields are not versioned.** Title, category and placement go live at
  Publish, even when Publish opens a merge request instead of merging.
  Reviewers see the body's diff, not a renamed title.
- **Publish over it overwrites** what was published in between. The review
  diff is the only safeguard until content merge exists (the same limit as
  [56](56-realtime-coediting.md#limits)).
- **A shared draft opened but never saved keeps its old base.** The branch
  then does not follow the default head, and Publish asks to review the newer
  head (`ponytail:` marker in `myDraftBranch`).
- **One working branch per person and page.** Two parallel edits of one page
  by one person are two named branches, made the old way.
- **A merge request per published edit**, merged ones included. The page's MR
  list grows with its edit history.
- **No MCP publish tool**, and the assistant's in-app create tool still makes
  open pages (phase 1 limits).
