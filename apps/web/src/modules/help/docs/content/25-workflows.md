---
title: Workflows
section: Using the app
summary: A configurable chain of steps run against one page, with a human approving each published result.
route: /workflows
---

A workflow is a graph of steps a workspace admin defines once and runs against a page:
*entity → use cases → API endpoints + frontend pages*, for example. Each step either
generates, drafts, searches, or waits for a review.

## How a run works

Starting a run **freezes the definition** into the run. Editing a workflow afterwards must
not change a run already in flight — the same reasoning that makes revisions immutable.

The fan-out lives as **rows**, not as opaque state inside a state machine, because the
feature has to answer questions like "every node awaiting review in this project" — which
a blob cannot. Each node is one queued job; a node that fans out produces child nodes, and
each child carries the chain onward when *it* is approved.

## Step kinds

| Kind | Does |
| --- | --- |
| `ai.generate` | fans out — produces N items, each becoming a child node |
| `ai.draft` | writes one page's content |
| `search` | looks something up in the workspace |
| `review` | stops and waits for a person |

The catalogue is closed and the executors live in code. A stored definition only ever
*names* steps and transitions — it never carries executable logic.

## Worker generates, API publishes

The worker produces content; it never writes a page. Approved nodes are left in
`materializing` and an API-side sweeper finishes them. Beyond the module boundary that
makes this necessary, it doubles as recovery: if the approving request dies mid-write, the
sweeper picks it up.

## Auto-start

Triggers are **off by default** and guarded four ways — category match, no prior run for
that page, a cap on concurrent active runs, and workflow events never re-triggering
workflows. The failure mode being guarded against is an avalanche of model calls, so the
defaults are conservative on purpose.

## Where

- `/workflows` — runs across the workspace, and `/workflows/:id` for one run's node tree.
- The **Workflows** widget on a page — where a chain usually starts.
- [Settings → Workflows](/settings/workflows) — the definition canvas (drag-and-drop).
- Over MCP: `knowledge_list_workflows`, `knowledge_start_workflow`,
  `knowledge_get_workflow_run`. Approval is deliberately **not** an MCP tool — stdio has no
  identity to attribute a published page to.
