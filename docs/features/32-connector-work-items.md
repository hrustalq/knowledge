# 32 — Connector detail page and work items

Оригинал: «add a detail page for connectors like github — we should also be able
to manage linked projects, issues to be able to handoff task to execution + sync
document state based on flows»

## What

A connector stops being a card in a list and becomes a place you can stand in.
`/settings/connectors/:id` shows one connection — what it is doing, what it has
claimed, and, for a GitHub-backed connector, **the work on the far side**:

| Tab            | What it carries                                                       |
| -------------- | --------------------------------------------------------------------- |
| **Work items** | Issues and pull requests, and the page each one is about. New issue.   |
| **Links**      | The external item ↔ page identity map feature 19 already kept.         |
| **Runs**       | This connector's sync history, without picking it from a dropdown.     |

Two things arrive underneath it. An **App-level webhook** turns what happens on
a repository into events on the bus the product already runs on, and a work item
can be **attached to a page**, which is what lets those events reach a workflow.

## Why

Feature 19 made external systems first-class as **sources of content**. That is
half of what a repository is. The other half is the work: the issue that says a
page is wrong, the pull request that makes it right, the task somebody wants
handed to whoever — or whatever — is going to do it. None of that was reachable
from here, and a knowledge base that can read a repository but cannot see that
an issue was closed against one of its pages is describing a world it cannot
observe changing.

The Runs and Links tabs were also, quietly, the wrong shape. Both opened with a
connector dropdown, because both lived on a workspace-wide page that had to ask
which connector you meant. Once there is a page **about** one connector, the
question is already answered, and the dropdown is a control that exists to undo
the page you navigated to.

## Decisions

**A work item is not a link.** `connector_links` maps external *content* onto a
page, and its `document_id` is `NOT NULL` because the hashes beside it are what
break the pull → push → webhook → pull echo loop; every sync reads that column.
A work item is a different relationship in three ways: it usually has no page at
all, its interesting state is a lifecycle rather than a content hash, and it is
what an inbound event is about. Folding them together would have meant making
`document_id` nullable on the table whose idempotence depends on reading it, and
would have made "is this page in sync" and "is this task done" the same
question. They are not.

**The row is a projection and never the truth.** Everything except the page
attachment is overwritten wholesale on the next read or delivery, which is what
lets `upsertFrom` be a blind write and why there is no local edit path. The one
field we own is the attachment, because it is the one fact GitHub does not have.
A refresh failure degrades to the stored rows rather than an error page: they
are still the last thing the far side told us, and a webhook lost while the API
was restarting would otherwise leave a stale row nobody could correct.

**`merged` is not `closed`.** GitHub reports a merged pull request as `closed`,
identically to an abandoned one; `merged_at` is the only field that separates
them. A flow that fires on "done" must not fire on work that was thrown away, so
the two are different states here and different events on the bus. This is most
of what `test/work-items.spec.ts` is about.

**The App-level webhook reverses a feature-30 decision, rather than working
around it.** Feature 30 left it out with a stated reason — "an App-level webhook
has no way to know which connector an event belongs to" — and the reason was
wrong. Every delivery carries `installation.id` and `repository.full_name`,
which together name exactly the connectors configured against that installation
and that repository. The per-connector hook at `/v1/connectors/:id/webhook` is
untouched: that one authenticates a repository hook somebody configured by hand,
this one authenticates GitHub delivering for a whole installation, and a
repository can have both.

It also does its work **inline** rather than enqueueing, which is the opposite
of what the per-connector hook does and deliberately so. That hook starts a
*sync* — unbounded work behind a public URL, which is a denial-of-service
surface. This one writes one row and publishes one frame per delivery, bounded
by the number of connectors on one repository.

**A repo event reaches a workflow through the page, or not at all.** Feature 17
already has event triggers: `WorkflowTriggerService` subscribes to the bus and
starts a run whose root is `event.documentId`. So `repo.*` events carry the
linked page's id when there is one, and nothing new is needed on the trigger
side — an attached work item reaches a flow through the path every other event
uses, and an unattached one reaches nothing. That asymmetry is the feature, not
a gap: a workflow runs *against a page*, and an issue nobody has connected to a
page has none to offer.

**`repo.` rather than `connector.repo.`** The existing `connector.*` events are
all about a sync run — our machinery. These are about the far side, and somebody
ticking a checkbox in a trigger picker should not have to know which connector
row delivered the news.

**One GraphQL call, and it is allowed to fail.** Projects v2 has no REST surface
whatsoever, so board membership is the single GraphQL query in the product. It
is batched with field aliases — one request per page of rows, not one per row —
capped at 50 lookups, and returns an empty map on any failure. Board names are
decoration on a list whose substance came from REST; a GraphQL hiccup must not
take the tab down with it.

**Two helpers moved to a leaf.** `verifyHubSignature` and `safeJson` lived on
`confluence.adapter.ts`, and four adapters already imported them from there —
harmless until a *controller* wanted them, at which point
`dip-connector-adapter-stays-behind-the-registry` correctly refused, because
reaching a named adapter is how `CONNECTOR_KIND_INFO` stops being the single
source of truth. They are about HTTP and HMAC and know nothing about Confluence,
so they are now `connectors/webhook-payload.ts`. Likewise the delivery's
connector lookup lives on `ConnectorsService` rather than in the controller:
`transaction-boundary-lives-in-a-service` is what keeps a write in a layer where
a transaction can later be introduced.

**`tasks` is an optional capability.** The other four on
`ConnectorCapabilities` are required because they describe how content moves and
every adapter has an answer. This one describes a second kind of object most
connectors do not have, so declaring it only where it is true keeps six adapters
from claiming a capability by boilerplate. The Work items tab is **absent**
rather than empty on a connector without it, and the reason is said once on the
connector — it is a property of the connection, not of this moment.

## Surface

```
GET    /v1/connectors/:id/work-items                      viewer
POST   /v1/connectors/:id/work-items                      editor
POST   /v1/connectors/:id/work-items/:workItemId/link     editor
DELETE /v1/connectors/:id/work-items/:workItemId/link     editor
POST   /v1/connectors/github/webhook                      public, HMAC-verified
```

Creating an issue is `editor`, not `admin`, and deliberately a lower bar than
editing the connector: opening an issue is ordinary work on content this
workspace already syncs, while changing a credential that reaches an external
system is not.

New event types, all in `REPO_EVENT_TYPES` and spread into `KNOWN_EVENT_TYPES`
so the trigger picker and the WS filter see them: `repo.issue.opened|closed|
reopened|commented|assigned|labeled`, `repo.pull-request.opened|closed|merged`,
`repo.push`, `repo.release.published`.

## Setup

The App needs more than feature 30 asked for. On
`https://github.com/settings/apps/<your-app>`:

| Section                   | Setting                                              |
| ------------------------- | ---------------------------------------------------- |
| Repository permissions    | Issues: **Read and write**                           |
| Repository permissions    | Pull requests: **Read and write**                    |
| Repository permissions    | Contents: Read and write (unchanged, feature 30)     |
| Organization permissions  | Projects: **Read and write** (Projects v2 boards)    |
| Webhook                   | **Active: on**                                       |
| Webhook URL               | `$API_PUBLIC_URL/v1/connectors/github/webhook`       |
| Webhook secret            | a new random string → `GITHUB_APP_WEBHOOK_SECRET`    |
| Subscribe to events       | Issues, Issue comment, Pull request, Pull request review, Push, Release, Project v2 item |

`installation` and `installation_repositories` are delivered to every App
automatically; there is nothing to subscribe to and no permission to request.

`GITHUB_APP_WEBHOOK_SECRET` empty is the off switch, matching `GITHUB_APP_ID`:
with no secret the endpoint refuses every delivery rather than trusting an
unsigned one. Everything else keeps working — a connector with a PAT, a
connector on the picker, the per-connector webhook.

## Deliberate deferrals

- **GitHub only.** `repoHost` already classifies the URL, so a GitLab remote is
  refused by reading the config the archive download would have read, rather
  than by a 404 from a GitHub path built out of a GitLab URL. GitLab issues are
  a second adapter's worth of work and were not asked for.
- **Boards are read, not managed.** Board membership is shown; adding an item to
  a board is not. It needs the item's GraphQL node id and a mutation, and the
  `projects_v2_item` webhook — which would keep membership live — fires only on
  *organization* webhooks and is still a GitHub public preview.
- **No `documents.status`.** "Sync document state based on flows" is served by
  the flow doing the writing: a repo event starts a workflow, and the workflow's
  existing steps produce revisions. A lifecycle column would have been a second
  state machine beside feature 17's, disagreeing with it eventually.
- **No document-side rail yet.** `listForDocument` exists and is what the
  assistant's task tools will read; the page-side widget is not built.
- **Work items are not searched or indexed.** An issue is not a page and does
  not enter the graph, for the reason feature 31 gives about code: a tool call
  is ephemeral, and reading an issue should not create a page.

## Verification

`make verify` passes, and `apps/api/test/work-items.spec.ts` covers the two
things that are load-bearing and not obvious: the state mapping (13 cases, most
of them about `merged` vs `closed`) and the signature check's rejections.

End to end, against a repository the App is installed on:

1. Open `/settings/connectors/:id` on a `codebase` or `markdown-git` connector.
   The Work items tab lists open issues and pull requests.
2. **New issue** opens one on GitHub. It appears in the list, and on GitHub.
3. Attach it to a page. Close the issue on GitHub. Within one delivery the row
   reads `closed` — that is the webhook, the signature check and the projection
   write all working.
4. A workflow whose trigger names `repo.issue.closed` and whose page is that
   page starts a run. An issue with no page attached starts nothing.
5. `GITHUB_APP_WEBHOOK_SECRET` empty: the endpoint 401s every delivery and
   everything else on the page still works.
