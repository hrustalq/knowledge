---
title: The pages landing
section: Using the app
summary: Graph, tree and list views over the same set, and which question each one answers.
route: /documents
---

Three views over the same pages, because "show me the documentation" is three different
questions.

## Graph (the default)

The workspace as a network: pages as nodes, their relations as edges. This is the view
that answers *how is this connected* — clusters of pages around one entity, a page with no
edges at all, a bridge between two areas nobody realized was load-bearing.

The graph is fetched once and cached, so switching away and back is instant.

## Tree

Containment: pages nested under pages, in the shape the parent links describe. This is the
view for *where does this belong* and for reorganizing — the same hierarchy the sidebar
shows, with room to work in.

Nesting is a real `parent_id` on the document, and moves are cycle-checked: you cannot
make a page its own ancestor.

## List

A flat table with filters, which is why the filter bar only appears in this view. Filter
by category and by project, sort, scan. This is the view for *find the one I mean* when
you already know roughly what it is called.

## Scope

The heading says which scope you are looking at — the active project, or the whole
workspace when no project is selected. Changing the project picker in the sidebar re-scopes
all three views.

## From here

- **New page** → `/create`, the editor with an empty document.
- **Import** → `/upload`, the three-step wizard for a file you already have.
- Clicking a page → its detail view.

Both create buttons need the `editor` role; a viewer sees the list without them.
