---
title: Use it from a coding agent
section: Reference
summary: Copy this documentation into Claude Code, Cursor or any agent as a skill.
widget: agent-skill
---

# Use it from a coding agent

> **Two skills, two jobs.** This page hands out the skill for an agent working **on this
> platform's codebase**. For an agent that should **use a knowledge base** — search it,
> cite it, propose edits — install the skill from
> [**Settings → Connect AI**](/settings/connect) instead: it is generated for your
> workspaces and connects through MCP.

An agent working on this codebase — or calling its API, or connected to its MCP server —
does better with the same orientation a person gets. This page hands it over as plain
markdown on your clipboard.

## What to copy

**Copy SKILL.md** — the whole thing shaped as a skill: frontmatter an agent can trigger
on, then orientation, the write path, the full endpoint table with its access column, the
MCP tool list, and the traps. This is the one to use.

**Copy full docs bundle** — every article on this site, concatenated. Reach for it when
the agent should read everything rather than be briefed.

Every ordinary article also has its own **Copy page** button, for when one topic is all
that is needed.

Both bundles include the **generated** API and MCP tables, so what the agent receives
matches this deployment rather than a snapshot of the docs from whenever they were written.

## Where to put it

**Claude Code** — save it as a skill and it loads itself when relevant:

```bash
mkdir -p ~/.claude/skills/knowledge-platform
pbpaste > ~/.claude/skills/knowledge-platform/SKILL.md
```

Use `.claude/skills/` inside the repo instead to share it with everyone working on it.

**Cursor** — paste into `.cursor/rules/knowledge-platform.md`. The YAML frontmatter is
harmless there; the body is what matters.

**Anything else** — paste it into the conversation, or save it as a file the agent can
read. It is ordinary markdown with no tooling requirements.

## Keeping it current

The tables come from `reference.generated.json`, refreshed by:

```bash
make docs-reference     # just the tables
make api-client         # OpenAPI → typed client → tables, the full chain
```

Re-copy after a release that changed the API surface. The prose lives in
`apps/web/src/pages/docs/content/` and versions with the code it describes, so a branch
that changes behaviour can change its documentation in the same diff.
