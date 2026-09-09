---
title: The assistant
section: Using the app
summary: A chat that answers out of the workspace, with tools bounded by the caller's own permissions.
---

# The assistant — `/assistant`

A chat grounded in the workspace. It answers from pages it actually read, and cites them.

## The tools it has

Three, and only three: **search the knowledge base**, **read a document**, **explore a
document's graph**. The loop is bounded by `ASSISTANT_MAX_TOOL_CALLS`.

Two rules make it safe to point at real content:

- **The workspace is pinned server-side.** It comes from the request, not from anything
  the model produced.
- **Every tool call is re-authorized against the caller's session.** The model asking to
  read a document is not permission to read it — the same access check an HTTP request
  would face runs again. Prompt-injected instructions inside a page cannot widen what the
  assistant reaches, because the model never held the access in the first place.

## The other endpoints

| Endpoint | What it does |
| --- | --- |
| `/v1/assistant/ask` | the chat above — tools, citations, streaming |
| `/v1/assistant/review` | reads a page and returns issues with severities (also the MR sidebar's AI check) |
| `/v1/assistant/suggest` | drafting help inside the editor |
| `/v1/assistant/related` | related pages — **no LLM at all**, it reuses search |

That last row is worth noticing: "related pages" is a search problem, so it is answered by
search.

## Skills

Skills are operator-authored instruction packs appended to the system prompt — either
picked explicitly in the composer, or matched by trigger words. At most 3 per turn, capped
in total length. They are trusted text, unlike page content, but the prompt states plainly
that a skill can never widen access.

## Providers

Which model answers comes from workspace AI settings, and a member can pin a specific
provider to their own thread. With `ASSISTANT_PROVIDER=none` the assistant is off and the
UI says so rather than failing at request time.

Configure everything at [Settings → AI](/settings/ai).
