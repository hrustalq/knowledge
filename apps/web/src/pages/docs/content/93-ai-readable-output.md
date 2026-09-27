---
title: llms.txt and markdown pages
section: Reference
summary: Every page as plain markdown and every workspace or project as an llms.txt, for tools that fetch URLs instead of speaking MCP.
---

# llms.txt and markdown pages

Agents that fetch URLs — a coding agent's web fetch, an IDE indexer — can read the
knowledge base without MCP. Every URL below is **private**: it needs the same access as
reading the page in the app, and a pinned or read-only API key narrows it exactly as it
narrows everything else.

| URL (on this site) | Returns |
| --- | --- |
| `/documents/<id>.md` | One page as markdown (`# title` + body) |
| `/documents/<id>` with `Accept: text/markdown` | The same; a browser still gets the app |
| `/llms.txt` | One section per workspace you can read |
| `/workspaces/<id>/llms.txt`, `/projects/<id>/llms.txt` | Every page in tree order, linking to its `.md` |
| `/workspaces/<id>/llms-full.txt`, `/projects/<id>/llms-full.txt` | Every page's text in one response, capped |

Only the default branch is exported — drafts and unmerged branches never appear.
[**Settings → Connect AI**](/settings/connect) lists the URLs for your current workspace
and project.

## Authenticating

A signed-in browser tab works as is. Anything else sends an API key as a header:

```bash
curl -H "Authorization: Bearer $KNOWLEDGE_API_KEY" https://<host>/workspaces/<workspaceId>/llms.txt
```

Never put a key in a URL: these site URLs do not forward a `?token=` query, and a URL ends
up in logs and browser history.

## Over MCP

The MCP server offers the same text as resources:
`knowledge://documents/<documentId>.md`, `knowledge://workspaces/<workspaceId>/llms.txt`
and `knowledge://projects/<projectId>/llms.txt`. There is no `llms-full` resource — use
search and per-page reads instead.

An administrator can turn the whole surface off with `AI_READABLE_ENABLED=false`.
