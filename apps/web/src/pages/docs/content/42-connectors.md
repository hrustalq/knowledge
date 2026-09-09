---
title: Connectors
section: Administration
summary: External systems as sources and destinations, the identity map that stops duplicates, and conflicts that become merge requests.
route: /settings/connectors
---

Confluence, Jira (pull only), Notion, and a generic markdown/git remote — which is what
covers an Obsidian vault, since a vault is a folder of markdown and Obsidian has no server
API.

## The link table is the feature

`connector_links` maps `(connector, external id) ↔ document`, and carries the content hash
and external version the two sides last agreed on. Without it:

- a second pull duplicates every page;
- a pull triggers a push, which triggers a webhook, which triggers a pull, forever.

With it, both loops break at the source: a pull skips when the external version is
unchanged, a push skips when the head hash still equals the link's, and a pull leaves the
link agreeing with what it just wrote.

## Conflicts become merge requests

When both sides changed the same page, the default `manual` policy writes the external
version to a `connector/<kind>-<id>` branch and records a conflict; a sweeper turns it
into a **merge request**. Structural and semantic diffs, threads and approval already
exist — so two-way conflict resolution cost a branch and no new UI.

## Setup is a wizard, not a form

The dialog is a state machine: a shared spine (name → configure → test → destination →
what it does → save) wrapping a per-connector machine that asks that system's own
questions (Confluence: site, then space; Notion: one step). It persists, so closing the
dialog — or the tab — resumes on the same sub-step and says so.

Testing saves a **disabled draft** connector first, because a connection test needs a row.

## Webhooks

`POST /v1/connectors/:id/webhook` is public and HMAC-verified over the **raw** request
body. It enqueues and does nothing else. A burst coalesces into a run still `queued` — a
running run's scope is frozen, so refusing the extra items would drop them.

## Warnings, again

Every adapter reports what it could not carry: Confluence macros, Notion block types,
Obsidian wiki-links. Same principle as import — a lossy sync that says nothing is the
failure worth preventing.

Same SSRF guard as AI plugins: private address ranges are refused unless
`CONNECTOR_ALLOW_PRIVATE_URLS` is set.

## Elsewhere

The **Connectors** widget on a page shows what it is linked to and offers **Push now**.
Over MCP: `knowledge_list_connectors`, `knowledge_sync_connector`,
`knowledge_get_connector_run`.
