# 86: Configurator

Tracking issue [#1250](https://github.com/hrustalq/knowledge/issues/1250). Phase 1 is
[#1311](https://github.com/hrustalq/knowledge/issues/1311). The shape brief is
[a comment on it](https://github.com/hrustalq/knowledge/issues/1311#issuecomment-7004482583).

## What

Setting up automation used to mean visiting several admin screens, and no agent could help: assistant write tools
are page-level only. The configurator turns a goal into a stored proposal of concrete changes. For example:

> Every Monday at 09:00 digest what changed, review every page merged in Payments, and check pull requests in the
> api repository for drift.

A person reviews the proposal and applies all, some or none of its changes.

Phase 1 proposes three kinds of change (`CONFIGURATION_CHANGE_KINDS`, contracts):

| Kind                    | Applied through                                                   | Activity recorded          |
| ----------------------- | ----------------------------------------------------------------- | -------------------------- |
| `agent-schedule`        | `AiAgentsService.update`: shape and note, never `scheduleEnabled` | `ai.agent.updated`         |
| `agent-trigger`         | `AgentTriggersService.create` with `enabled: false`               | `ai.agent.trigger.created` |
| `connector-drift-check` | `ConnectorsService.update`: the config's `driftCheck` (doc 35)    | `connector.updated`        |

"Run the sentinel on every PR" is a drift check, not a trigger. The sentinel is not triggerable. Later phases add
workflow drafts and templates (#1312), project settings (#1313), and skills and agents taken from blueprints
(#1314).

## How

- **The agent.** `configurator` is a built-in agent (`interactive`, `requires: ['tools']`). It runs on the API side
  through `AssistantClient.runWithTools`, as Describe it does (doc 73). Its tools belong to `ConfiguratorService`, not
  to the agent's editable list, which is why `tools` is empty in `built-in-agents.ts`. There are four reads
  (`list_agents`, `list_agent_triggers`, `list_projects`, `list_connectors`) and one write, `propose_configuration`.
  That write creates or replaces the proposal row and nothing else. The executor answers only those names, and it
  checks them on execution. Tool output is wrapped as untrusted. Trigger notes, owners and webhooks are never read
  out.
- **One parse.** `readChanges` (`configurator/configuration-changes.ts`, zod, API-side) narrows each change on its
  own:
  - A bad change is dropped and reported back to the model, so it can call again.
  - A weekly schedule without weekdays never reaches a proposal.
  - A time-of-day schedule with no zone takes the requester's browser zone.
  - The model is also told that zone in the prompt.
- **Assessed, then stored.** `ConfiguratorService.assess` resolves each change's target, its diff against today and
  whether it can apply. Fields neither side sets are left out of the diff. `unavailable` is one of
  `CONFIGURATION_UNAVAILABLE_REASONS`:
  - already configured;
  - the agent cannot be scheduled or triggered by that event;
  - not found in the workspace;
  - the connector has no drift check;
  - `AGENT_SCHEDULE_ENABLED` / `AGENT_TRIGGERS_ENABLED` is off.

  An unavailable change is shown with its reason and never offered for apply. Per-change state lives in
  `configuration_proposals.changes` (JSONB). The proposal's own status is derived, never stored.
- **Apply is a person's act.** `ConfigurationApplyService`:
  1. Checks the role each picked change requires before writing anything. Every phase-1 kind needs workspace admin.
     An editor who drafted a proposal gets 403 and nothing is written.
  2. Assesses each change again under the proposal's advisory lock. A change configured by hand in the meantime
     lands `unavailable`, not as a duplicate.
  3. Applies the picked changes in one transaction: all or nothing. A refusal names the change in `details.changeId`.

  Activity and the agent-cache invalidation run after commit.
- **Who sees what.** Editors and admins draft (`@Access('editor', …)`, `@Feature('assistant')`). An admin lists and
  applies everyone's proposals. Anyone else lists their own, and another person's proposal is a 404.
- **Web.** `/settings/ai/configurator` (`ConfiguratorPanel.vue`) has a goal box and the open proposal. Each change
  is a row with its kind, target, the model's reason and a *today → proposed* table. Applied rows link to Agents,
  where schedules and triggers are switched on. Below that is the history. A non-admin sees "a workspace admin
  applies these" instead of Apply. Model text is plain text only.

## Not done

- A conversation: each goal is one proposal. Refine by asking again.
- An MCP tool.
- Applying without a person, which is out of scope for every phase.
