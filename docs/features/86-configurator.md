# 86: Configurator

Tracking issue [#1250](https://github.com/hrustalq/knowledge/issues/1250). Phase 1 is
[#1311](https://github.com/hrustalq/knowledge/issues/1311), phase 2
[#1312](https://github.com/hrustalq/knowledge/issues/1312), phase 3
[#1313](https://github.com/hrustalq/knowledge/issues/1313). The shape brief is
[a comment on it](https://github.com/hrustalq/knowledge/issues/1311#issuecomment-7004482583).

## What

Setting up automation used to mean visiting several admin screens, and no agent could help: assistant write tools
are page-level only. The configurator turns a goal into a stored proposal of concrete changes. For example:

> Every Monday at 09:00 digest what changed, review every page merged in Payments, and check pull requests in the
> api repository for drift.

A person reviews the proposal and applies all, some or none of its changes.

It proposes six kinds of change (`CONFIGURATION_CHANGE_KINDS`, contracts):

| Kind                    | Applied through                                                   | Role on apply                     | Activity recorded          |
| ----------------------- | ----------------------------------------------------------------- | --------------------------------- | -------------------------- |
| `agent-schedule`        | `AiAgentsService.update`: shape and note, never `scheduleEnabled` | admin                             | `ai.agent.updated`         |
| `agent-trigger`         | `AgentTriggersService.create` with `enabled: false`               | admin                             | `ai.agent.trigger.created` |
| `connector-drift-check` | `ConnectorsService.update`: the config's `driftCheck` (doc 35)    | admin                             | `connector.updated`        |
| `workflow-draft`        | `WorkflowsService.create` with `enabled: false` (doc 17)          | admin                             | `workflow.created`         |
| `page-template`         | `TemplatesService.create` (doc 42)                                | editor for a project's, else admin | `template.created`        |
| `project-setting`       | the setting's own service (doc 76), see below                     | maintainer; admin for the gates   | lint gate only: `ai.lint-policy.updated` |

"Run the sentinel on every PR" is a drift check, not a trigger. The sentinel is not triggerable. A later phase adds
skills and agents taken from blueprints (#1314).

A `project-setting` change names one of `CONFIGURABLE_PROJECT_SETTINGS` (contracts) and only the keys it sets; a key
set to null goes back to inheriting:

| Setting           | Keys                                                                   | Written by                                       | Role on apply |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------------ | ------------- |
| `verification`    | `reviewIntervalDays`, `remindBeforeDays`, `inactiveAfterDays`, `emptyMaxChars` | `VerificationPolicyService.updateProject` | maintainer    |
| `workItems`       | `issues`, `conflicts`, `verification`                                  | `WorkItemRulesService.setProject`                | maintainer    |
| `breakingChanges` | `policy`                                                               | `ApiSettingsService.setProjectBreakingChanges`   | admin         |
| `lintPolicy`      | `policy`                                                               | `LintChecksService.setPolicy`                    | admin         |

The capture parent is not one: the configurator reads no pages, so it has no page id to name. The methodology is
not one either: switching it has its own preview of what moves (doc 82).

## How

- **The agent.** `configurator` is a built-in agent (`interactive`, `requires: ['tools']`). It runs on the API side
  through `AssistantClient.runWithTools`, as Describe it does (doc 73). Its tools belong to `ConfiguratorService`, not
  to the agent's editable list, which is why `tools` is empty in `built-in-agents.ts`. There are four reads
  (`list_agents`, `list_agent_triggers`, `list_projects`, `list_connectors`) and one write, `propose_configuration`.
  That write creates or replaces the proposal row and nothing else. The executor answers only those names, and it
  checks them on execution. Tool output is wrapped as untrusted. Trigger notes, owners and webhooks are never read
  out. Phase 2 adds `list_workflows` and `list_templates`, workspace-wide rows only: a project's definitions and
  templates stay out, as the templates gallery keeps them.
- **One parse.** `readChanges` (`configurator/configuration-changes.ts`, zod, API-side) narrows each change on its
  own:
  - A bad change is dropped and reported back to the model, so it can call again.
  - A weekly schedule without weekdays never reaches a proposal.
  - A time-of-day schedule with no zone takes the requester's browser zone.
  - The model is also told that zone in the prompt.
  - A workflow draft's steps go through the architect's own reader (`readWorkflowSteps`,
    `workflows/workflow-draft.service.ts`), then `validateGraph` (`@knowledge/workflow`). A graph with an error is
    dropped and its issues go back to the model. `autoApprove` is never taken from the model, and the trigger is
    `WorkflowsService`'s default plus what the goal asked (auto-start, events from the settings form's list,
    categories).
  - A template's source goes through `parseTemplateSource`; one that does not parse is dropped the same way.
    The configurator never overrides a built-in or edits an existing template.
  - A project setting takes the bounds and vocabularies of its route's DTO, one zod shape per setting. One that
    names no key is dropped. So is one naming a project the requester may not open (`canSeeProject`): its diff
    would show settings their own route would not.
- **Assessed, then stored.** `ConfiguratorService.assess` resolves each change's target, its diff against today and
  whether it can apply. Fields neither side sets are left out of the diff. `unavailable` is one of
  `CONFIGURATION_UNAVAILABLE_REASONS`:
  - already configured;
  - the agent cannot be scheduled or triggered by that event;
  - not found in the workspace;
  - the connector has no drift check;
  - `AGENT_SCHEDULE_ENABLED` / `AGENT_TRIGGERS_ENABLED` is off;
  - the workspace has the `workflows` section off (`section-off`, workflow drafts and templates both);
  - a workflow or template of that name exists where it would land (`name-taken`);
  - a workflow draft no longer compiles (`invalid`): a template its graph names went away, which `templateIssues` asks.

  A project setting's diff (`ProjectSettingChanges`, `configurator/project-setting-changes.ts`) reads each key through
  its route's own service. `before`/`after` are the project's own value (null = inherits). `applies` holds what takes
  effect at each side, the level that decides it (`project` / `workspace` / `default`) and `held`. `held` is `ceiling`
  when `STYLE_LINT_POLICY` clamps a lint value (through `resolveLintPolicy`, the merge gate's own resolver), or when
  `WORK_ITEM_AUTOCREATE_MAX_PER_TICK` is 0 and no rule creates anything. It is `agent-off` when the style linter is
  switched off. Already-configured means the project already holds every proposed value. The model reads one
  project's settings in the same shape through `get_project_settings`.

  An unavailable change is shown with its reason and never offered for apply. Per-change state lives in
  `configuration_proposals.changes` (JSONB). The proposal's own status is derived, never stored.
- **Apply is a person's act.** `ConfigurationApplyService`:
  1. Checks the role each picked change requires before writing anything, by `requiresFor(spec)` — the rule of the
     change's own route, read from the spec, never from the stored `requires`. A project's page template needs editor
     (`templates.controller.ts`). A project's thresholds and handoff rules need its maintainer, through
     `PermissionService.requireProjectManage` (doc 76: an admin, or an editor holding a `manage` grant). Its two merge
     gates and every other kind need workspace admin. An editor who picks a change beyond their role gets 403 and
     nothing is written.
  2. Assesses each change again under the proposal's advisory lock. A change configured by hand in the meantime
     lands `unavailable`, not as a duplicate.
  3. Applies the picked changes in one transaction: all or nothing. A refusal names the change in `details.changeId`.

  Activity and the agent-cache invalidation run after commit.
- **Who sees what.** Editors and admins draft (`@Access('editor', …)`, `@Feature('assistant')`). An admin lists and
  applies everyone's proposals. Anyone else lists their own, and another person's proposal is a 404.
- **Web.** `/settings/ai/configurator` (`ConfiguratorPanel.vue`) has a goal box and the open proposal. Each change
  is a row with its kind, target, the model's reason and a *today → proposed* table (a template's source is cut to
  its first 400 characters). A project setting's row shows the project's own value with what applies beneath it,
  and names any hold. Applied rows link to Agents, Workflows or Templates, wherever they are switched on or
  seen. Below that is the history. Only the changes the person may apply can be ticked: a maintainer's rows ask the project's own
  `project:manage-settings` answer (`GET /v1/projects/:id`). When some need someone else, the panel says so. Applied
  project settings link to that project's Policies page. Model text is plain text only.

## Not done

- A conversation: each goal is one proposal. Refine by asking again.
- An MCP tool.
- Applying without a person, which is out of scope for every phase.
