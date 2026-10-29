---
title: What this is
section: Getting started
summary: A documentation store that keeps a graph, a revision history and a semantic index of everything written into it.
---

# What this is

A **dynamic knowledge platform**: pages are markdown, but each one is also a node in a
graph, a chain of immutable revisions, and a set of embedded chunks you can search by
meaning. Three interfaces read the same data — this web app, a REST API under `/v1`, and
an MCP server that agents connect to over stdio.

The point of the design is that documentation stops being a pile of files. A page can say
what it depends on, and the platform can then answer _what breaks if this changes_. A page
has a history you can branch, review and merge, so a change to the docs goes through the
same motions as a change to code. And every page is indexed, so a question finds the
passage that answers it rather than the file that happens to share a word with it.

## Containment

Three levels, and no more:

```
Workspace  ─ the tenant. Every ACL, every graph query and every storage key is scoped to it.
  └ Project  ─ organizational only. No members, no roles.
      └ Document  ─ a page. Belongs to exactly one project, and may nest under another page.
```

A workspace is the security boundary: membership in it is what grants a role
(`viewer` < `editor` < `admin`), and a graph query that somehow omitted the workspace
predicate would be a cross-tenant leak, so every graph read goes through one service that
adds it.

A project is a folder that means something to people and nothing to the machine — it is
deliberately absent from the graph, which models semantic facts rather than UI structure.

## Three stores, three jobs

Nothing is written to two of them for the same reason:

| Store          | Holds                                                                               | Why it is the one                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL** | documents, branches, revisions and their parent DAG, jobs, merge requests, settings | transactional truth — a revision and the job that will index it commit together                                           |
| **MinIO**      | the raw bytes of every revision                                                     | versioned object storage; clients upload straight to it with a presigned URL, so page bodies never stream through the API |
| **ArcadeDB**   | the graph and the vectors                                                           | documents, revisions and chunks as vertices; typed relation edges; embeddings for semantic search                         |

The split is what makes the write path safe. A page's bytes land in object storage first,
then a single Postgres transaction records the revision _and_ the ingestion job that will
index it. If the worker is down, the job waits; if the worker crashes mid-flight, a sweeper
re-queues it; if it runs twice, indexing is idempotent by construction.

## What you can do with it

- **Write** pages in a WYSIWYG editor that round-trips through markdown, or **import**
  them from PDF, Word, PowerPoint, HTML, CSV or plain text.
- **Search** by meaning, by keyword, or both fused together — then walk the graph outward
  from the results to pages that are related but never mention your words.
- **Review** changes as merge requests, with structural and semantic diffs, inline threads
  and approval gates.
- **Comment** on any passage of any page, anchored to the quoted text rather than a line
  number, so the note survives the paragraph being rewritten around it.
- **Automate** with workflows (a configurable chain of steps run against a page) and
  agents (named, configurable AI actors with their own instructions and tool allowlists).
- **Connect** external systems — Confluence, Jira, Notion, a markdown git remote — as
  sources, destinations, or both.
- **Ask** an assistant that answers out of the workspace and cites the pages it used.

## Where to go next

- [Quickstart](/settings/docs/quickstart) — get it running and put a page through the
  whole pipeline.
- [Documents and revisions](/settings/docs/documents-revisions) — the model everything
  else sits on.
- [REST API](/settings/docs/api-reference) and [MCP server](/settings/docs/mcp-server) —
  the two programmatic surfaces.
- [Use it from a coding agent](/settings/docs/agent-skill) — copy this documentation into
  Claude Code, Cursor or any agent as a skill.
