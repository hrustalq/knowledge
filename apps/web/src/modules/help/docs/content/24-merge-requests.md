---
title: Merge requests and review
section: Using the app
summary: Branch, diff three ways, discuss on the rendered page, and the gates that stand between an MR and its merge.
route: /merge-requests
---

## The list

Every MR in the workspace, filterable by status, author, reviewer and title text. The
status tabs carry counts computed under the *same* filter scope, so "Open 3" means three
open ones matching what you are looking at, not three overall.

The **Filters** rail on the left saves a whole narrowing — status tab, search text and
every chip — under a name, addressable as `?view=7`. Saved filters are **private to
their owner**: someone else's returns 404 rather than 403, because a private view should
not confirm it exists. An applied filter shows an *edited* marker as soon as you change
anything, so it can never silently claim to be showing what it was saved as.

## The detail view

Four tabs: **Overview**, **Changes**, **Structure**, **Impact** — plus **Review**.

- **Changes** — the line diff, with inline comment threads in the gutter.
- **Structure** — the path-level diff: which frontmatter fields or JSON paths changed.
- **Impact** — the semantic diff: which relation edges this change asserts or drops, and
  how far the page's meaning moved.
- **Review** — the page rendered *at the source head*, annotated the way you would
  annotate a PDF. Select a passage, comment, resolve. Same anchoring as page comments, and
  deliberately the same UI.

The sidebar holds assignee, reviewers (advisory — they are not a gate), approval ticks, and
an optional **AI check** that runs the review agent over the source head.

## The merge gates

Merge is refused, with a reason, when:

| Reason | Fix |
| --- | --- |
| `draft` | it is marked draft — untick it |
| `approvals` | fewer than `MR_REQUIRED_APPROVALS`; the author's own approval never counts |
| protected branch | the target is protected and you are not a workspace admin |
| `conflict` | the target changed the same lines the branch did — **Resolve conflicts** |

When the target moved on since the branch began, each page is merged **3-way**, the way git
does it: changes to different lines of a page both land, and only changes to the same (or
adjacent) lines conflict. The **Branch** row of the checklist says which. A clean branch can
merge as it is, or take **Update branch** first. A conflicting one holds the merge until
**Resolve conflicts** is done: the conflict view shows each page with git's markers
(`<<<<<<<` the target, `=======`, `>>>>>>>` the branch), you keep what should stay and delete
the markers, and **Update branch** merges the target into the branch. Nothing is rebased;
history only grows. Pages you cannot open are counted, and someone who can open them has to
resolve them.

Merging then writes either a **merge commit** (two parents: target head, source head) or a
**squash** (one parent) carrying the merged text, and runs the normal finalize → index
pipeline.

In `AUTH_MODE=none` the approval gate is skipped, because the dev principal is also the
stub author and self-approval exclusion would deadlock every merge.

## Discussions

Threads anchor to a line, a section or an entity. Line anchors pin a revision, a line and
an excerpt, and are best-effort: when a diff moves past them, the thread falls back to the
Discussion tab rather than pointing at the wrong line. Threads can be plain comments or
resolvable threads; only the latter count as unresolved.
