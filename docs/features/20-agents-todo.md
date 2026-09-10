# 20 — Agents: remaining work

Backlog for the agents feature (see `20-agents.md` for the design). Phases A–D
shipped first; items 1–8 of the original backlog are now closed and recorded
below, with what was decided where the item was a decision rather than a build.

Effort: S (≤half a day), M (a day or two), L (more).

---

## Closed

**1. `'event'` in `AGENT_RUN_TRIGGERS` — dropped.** Option (a). The union is
`manual | schedule`; nothing produced an event-triggered run, and a closed
vocabulary that promises a value the code never emits is the defect this feature
was written against. Re-add it together with the `AgentTriggerService` that
emits it, carrying `WorkflowTriggerService`'s five guards verbatim
(`workflows/workflow-trigger.service.ts:46`) — the guards are only trustworthy
against a real workload, and nothing in the product asks for event-driven
curation yet.

**2. Schedule UI.** In the editor dialog, shown for a runnable agent: enable,
interval (min 15, the DTO floor), a note seeded into every run, and the last-run
line. The roster shows an `every N min` badge, and there is now a **Run now**
button — the Runs tab's empty state told people to start a run from the Agents
tab, which had no way to do it.

**3. MCP — `knowledge_list_agents` only.** Recommendation taken. `McpModule`
imports `AgentCoreModule`; the tool projects to `AiAgentChoice` (names and
descriptions, never prompts). There is deliberately no `knowledge_run_agent`,
and `mcp.service.ts` says why at the point somebody will look for it: stdio has
no principal, `agent_runs.created_by` is NOT NULL so a run always has an owner,
and starting unattended AI from an unauthenticated transport is not a place for
`AUTHOR_ID_STUB`.

**4. `/v1/assistant/ask` — left as it is.** Option (a), and the comment in
`ask()` now records it as a decision rather than an open question, including
what it costs (no admin can edit that prompt) and what closes it when someone
asks: a `page-answerer` built-in.

**5. Findings → merge requests.** `POST /v1/ai/agents/runs/:id/findings/:index/propose`
(`@Access('editor', 'query')`), API-side only. Runs the `drafter` over the cited
page, then the same branch → revision → `MergeRequestsService.create` path
`propose_update` uses, attributed to the caller rather than the run's owner. The
slot is claimed by a guarded `jsonb_set` before the model is called, so two
presses cannot both open a merge request, and released again if the proposal
fails. `orphan` findings are refused — their fix is a relation, not prose.

**6. Background executors.** `RUNNABLE_AGENTS` is now
`curator | reviewer | glossarist`. The reviewer reads the most recently indexed
pages, one call each, and translates its `issues` shape into findings cited at
the page under review; the glossarist proposes undefined terms through the very
`GlossaryService.suggest` the settings page calls, which is what
`GlossaryCoreModule` exists for. `researcher` lost its `background` surface
instead of gaining an executor. `AiAgentSummary.runnable` exposes the set, and
the API guard, the schedule sweeper and the UI all read it — a `background`
surface is a declaration, this is the fact.

**7. Cleanups.** `openCall` no longer runs for chat (the turn opens on its
agent, so the config is resolved once, and the disabled check now reads the
config the call actually uses); the dead `RELATION_EXTRACTOR` provider and
symbol are gone; `AiSkillsService` moved into `AiCoreModule`, so the workflow
executors and the curator render skills through `renderPrompt(forTurn(...))` and
feature 17's duplicated renderer is deleted — an agent's own `skillIds` now
reach a workflow step and a background run, not only chat. `AiSettingsSourceMap`
was left describing the inline row it actually describes; the Config tab states
that an agent can override those fields and points at the Agents tab, which is
where per-agent overrides are already badged.

**8. Committing.** Moot — the tree was already committed (`e832ec7`,
`9065dbf`); `saved_filters` and connectors landed separately as hoped.

---

## Open

### A. Event triggers, when something asks for them — M

See item 1 above for the shape and the guards. The gate is a real trigger to
hang it on, not the code.

**Still open, and docs/features/21 is deliberately not it.** Tagging `@reviewer`
in a discussion does start an agent from something that happened, but it is a
person addressing an agent in a conversation, not an event trigger: it produces a
comment rather than an `agent_runs` row with findings, and it has an owner by
construction — the person who typed the mention — which is the property
`agent_runs.created_by NOT NULL` exists to guarantee and the thing an
event-triggered run has to invent. Feature 21 needed none of the five
`WorkflowTriggerService` guards, because a mention is rate-limited by somebody
typing it. So this item still wants a genuinely unattended workload, and the
guards remain the interesting part.

### B. `AgentTiebreakService` has no background counterpart — S

`AgentRouterService.route()` takes the tiebreak as a call argument precisely so
the worker can run without one, and it does. What that means in practice is that
routing in the worker stops at the rules — correct, just less specific. Worth
measuring before deciding whether it matters: if scheduled runs are only ever
started for an explicitly named agent, the tiebreak is never reachable there and
the asymmetry is free.

### C. A finding has no "dismiss" — S

Propose is the only verb. A finding a reviewer judges wrong stays in the run
forever, and the next run finds it again. The cheap version is a `dismissedAt`
beside `proposedAt` on the finding (the same guarded `jsonb_set`), plus a filter
in the runs panel; the honest version notices that a dismissal is only useful if
the *next* run knows about it, which means matching findings across runs and is
a bigger question than the field.

### D. Reviewer findings are all `kind: 'other'` — S

`AGENT_FINDING_KINDS` has six values and the reviewer maps to one, because its
prompt speaks in severities rather than kinds. Either map its `severity` +
message onto the kinds (guessy), or give the reviewer a background-specific
output contract that names a kind — which is the `instructionsFor(surface)` idea
item 4 rejected for one call site, and it would have two here.

### E. Disabling a chat built-in does nothing — S

`resolveTurnAgent`'s last line returns the mode's default (`researcher` /
`author`) through `agents.resolve` with no `conversational()` filter, so an
admin who unticks *enabled* on the researcher still gets the researcher on every
Ask turn. Every other consumer honours the flag (`AgentRunsService.start`
refuses, `ExtractorFactory` returns the noop), which makes this the odd one out.

It was left alone deliberately while cleaning up `openTurn`: refusing the turn
is a behaviour change, and the only message the chat has for it — "Assistant
disabled for this workspace" — describes the provider being off, not one agent.
The decision to take is what disabling the *fallback* agent means: fall through
to the other conversational candidate, refuse the turn with a message that says
which agent is off, or forbid disabling the two chat defaults at all.

### F. Nothing shows a scheduled run's cost — M

`ai_usage` records every call with `operation: 'agent'` and the run's owner, but
the Usage tab aggregates by operation and the Runs tab shows no tokens at all.
An admin turning on a nightly curator cannot see what it spends without reading
the usage chart sideways. The join is `ai_usage.user_id` + the run window; a
`runId` on `ai_usage` would be better and is a migration.
