---
title: MCP server
section: Reference
summary: What an agent can do over stdio, how to connect one, and the two things it deliberately cannot do.
widget: mcp-tools
---

# MCP server

A third entrypoint of the same application, speaking Model Context Protocol over **stdio**.
Start it with:

```bash
make dev-mcp
```

Tool names use underscores because MCP forbids dots, but they map one-to-one onto the
platform's own vocabulary: `knowledge_search` is `knowledge.search`.

## Connecting an agent

Claude Code, or any MCP client, needs the command and the working directory:

```jsonc
{
  "mcpServers": {
    "knowledge": {
      "command": "make",
      "args": ["dev-mcp"],
      "cwd": "/path/to/knowledge"
    }
  }
}
```

Two things to know before you point an agent at it:

- **stdout belongs to JSON-RPC.** Nest's logging is disabled in this entrypoint; boot
  errors go to stderr. Anything that prints to stdout breaks the protocol.
- **There is no ambient workspace.** stdio carries no session, so every tool that touches
  content takes a `workspaceId` explicitly. Start from `knowledge_list_projects` if you do
  not have one.

## What it deliberately cannot do

- **Approve a workflow node.** Publishing a page needs an identity to attribute it to, and
  stdio has none.
- **Run a background agent.** An agent run requires an owner for the same reason — the
  column is `NOT NULL` on purpose, so that spend and authorship are always attributable.

Merge-request actions *are* available, and act as a stub identity. That identity's
approval counts toward the merge gate — unless the MR was also authored over MCP, since
self-approvals never count.

## Suggested flow for an agent

1. `knowledge_list_projects` — find the scope.
2. `knowledge_search` — find the pages, with citations.
3. `knowledge_get_document` — read one.
4. `knowledge_find_relations` / `knowledge_impact_analysis` — find what a change touches.
5. `knowledge_create_branch` → `knowledge_create_revision` → `knowledge_create_merge_request`
   — propose a change rather than writing to the default branch.

`knowledge_query_graph` is the escape hatch: a single `SELECT`, row-capped, wrapped in the
mandatory workspace predicate, and written to the audit log. It requires the
`trusted_operator` flag.

## The tools
