---
title: MCP server
section: Reference
summary: The knowledge_* tools over HTTP or stdio, how a client connects, and the two things they deliberately cannot do.
widget: mcp-tools
---

# MCP server

The platform's Model Context Protocol surface: the `knowledge_*` tools, served two ways.

| Transport | Where | Acts as |
| --- | --- | --- |
| **Streamable HTTP** | `POST /v1/mcp` in the API | the bearer's account, narrowed by its key |
| **stdio** | `make dev-mcp`, a local process | full access; writes attributed to an anonymous stub |

Tool names use underscores because MCP forbids dots, but they map one-to-one onto the
platform's own vocabulary: `knowledge_search` is `knowledge.search`.

## Connecting a client

Use [**Settings → Connect AI**](/settings/connect). It creates a key and gives you the
exact command and config file for Claude Code, Codex, Gemini CLI, Cursor, VS Code, Claude
Desktop, Windsurf, opencode and Zed — with the key already filled in, the one time it is
on screen. The shape every one of them boils down to:

```json
{
  "mcpServers": {
    "knowledge": {
      "type": "http",
      "url": "https://<host>/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${KNOWLEDGE_API_KEY}" }
    }
  }
}
```

The server is **stateless**: every request is authenticated and authorized on its own, and
`GET` (a server-push stream) answers 405, which clients handle. `API_PUBLIC_URL` is the
base of the URL the settings page hands out.

For stdio, a client needs the command and the working directory:

```jsonc
{ "mcpServers": { "knowledge": { "command": "make", "args": ["dev-mcp"], "cwd": "/path/to/knowledge" } } }
```

Anything that prints to stdout breaks the stdio protocol; logs go to stderr.

## Permissions

Over HTTP every tool runs the same role check as the REST route it mirrors — `viewer` to
read, `editor` to write, `admin` + trusted operator for `knowledge_query_graph` — and
every write is recorded as the key's owner. A **read-only** key is not even offered the
write tools, and each tool is annotated `readOnlyHint` so a client can auto-approve reads
and still ask before a write.

There is no ambient workspace: every content tool takes a `workspaceId`. Start from
`knowledge_whoami`, which lists every workspace the connection reaches with its projects.

## The skill

`GET /v1/mcp/skill` returns a `SKILL.md` generated for the caller — their workspaces and
project ids, the tools they are offered, and the playbooks below. The same text is the MCP
resource `knowledge://skill` and the prompt `guide`. Install it from the Connect AI page.

## What it deliberately cannot do

- **Approve a workflow node.** Publishing is a person's decision, not an agent's.
- **Run a background agent.** An unattended AI run begins from the Agents tab or a
  schedule, both of which name a real user.

Merge-request actions *are* available. An author's own approval never counts toward the
merge gate — so an agent that opens a merge request cannot also push it through.

## Suggested flow for an agent

1. `knowledge_whoami` — find the scope.
2. `knowledge_search` — find the pages, with citations.
3. `knowledge_get_document_content` — read one in full.
4. `knowledge_find_relations` / `knowledge_impact_analysis` — find what a change touches.
5. `knowledge_create_branch` → `knowledge_create_revision` → `knowledge_create_merge_request`
   — propose a change rather than writing to the default branch. New pages go through
   `knowledge_create_document`.

`knowledge_query_graph` is the escape hatch: a single `SELECT`, row-capped, wrapped in the
mandatory workspace predicate, and written to the audit log. It requires the
`trusted_operator` flag.

## The tools
