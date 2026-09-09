---
title: The page view
section: Using the app
summary: The reading surface, the rail of widgets beside it, and how commenting on a passage works.
---

# The page view — `/documents/:id`

The main column is **only the page**. Everything *about* the page — history, relations,
activity, open changes — lives in a rail of stacked widgets beside it, each collapsed to a
single row that carries the one fact which decides whether you need to open it: `#2`,
`1 field`, `2 revisions`, `45 relations`, `4m ago`.

## The rail

| Widget | Shows |
| --- | --- |
| **Overview** | project, category, status, relations (capped, with a *+N more* toggle) |
| **Frontmatter** | the page's own metadata — hidden entirely on pages that have none |
| **History** | revisions, the branch each sits on, diffs between any two |
| **Changes** | merge requests touching this page |
| **Graph** | a subgraph around this page, walked to a chosen depth |
| **Workflows** | runs against this page, and where to start one |
| **Connectors** | external systems this page is linked to — including **Push now** |
| **Activity** | who did what, when |

Overview is open by default; the rest stay shut until you want them. Several can be open
at once, and each expandable one has a **Maximize** control that lifts it into a dialog
when a widget deserves the whole screen. A widget's body is only mounted while it is open,
so the graph does not build a canvas nobody asked for.

Deep links still work: `?tab=graph` opens that widget on arrival.

## The content itself

The page renders through the **same editor component** used for writing, in read-only
mode. Read and edit are one component on purpose — a page cannot look one way when read
and another when opened.

Two consequences you can see:

- If the markdown starts with an `# H1` matching the page title, it is dropped. The header
  already shows the canonical title, and nearly every page repeats it.
- **On this page** is derived from what actually rendered, so section links survive a
  rewrite.

## Commenting on a passage

Two ways in, no discussion list at the bottom:

1. **Select text** → a floating **Comment** button appears.
2. **Hover a block** → a control appears in the margin.

Commented passages stay highlighted with a count pin; clicking one opens its threads, with
reply and resolve inline. A remark can be a plain **comment** or a **thread** that stays
open until someone resolves it — only threads count toward the unresolved tally.

Anchors are **quote-based**, not positional: a comment stores the quoted text plus a little
context on either side. Rewrite the paragraph around it and the note still lands; delete
the sentence it quoted and the comment is reported **outdated** rather than silently
re-attached to something else. That is the honest failure and the deliberate one.

Commenting is disabled while viewing a historical revision (`?revision=`) — you are
looking at the past, and a note there could never be answered.

## Editing

**Edit** opens `/documents/:id/edit`. Saving creates a new revision on the current branch
and queues reindexing; it does not overwrite anything.
