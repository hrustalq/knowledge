# 77 — Workspace purpose

Milestone [#934](https://github.com/hrustalq/knowledge/issues/934). Every new
workspace started with all ten sections of `WORKSPACE_FEATURES` on. A team that
only keeps meeting notes still saw QA, the git remote and Conflicts, and its
agents were offered those sections' tools. The only remedy was ten checkboxes
in Settings → Features that nothing pointed a new admin to.

A workspace now records what it is used for, and that suggests which sections
are on. The admin of a new workspace is asked once.

## Decisions

- **Purpose is advice; `workspace_settings.disabled_features` stays the only
  switch.** Nothing in [70 — Feature toggles](70-feature-toggles.md) changed:
  the guard, the MCP gate and the web all still read the one list. A purpose
  only proposes what that list should be, and an admin confirms it.
- **A closed catalogue of uses.** The model picks uses, never a section key.
  The map from uses to sections is code.
- **No "set by hand" flag.** Moving from one purpose to another is a pure
  reconcile over (previous uses, next uses, the current list).
- **Existing workspaces are left alone.** The migration stamps every workspace
  that exists as already asked. None is redirected and none is re-toggled.
- **The interview borrows the `scaffolder`'s model**, the way memo triage
  borrows the secretary's: its own contract, its own usage operation, no tools
  and none of the agent's instructions.
- **No model is not an error.** The same wizard works as a plain checklist.

## The catalogue and its map

`WORKSPACE_USES` in `@knowledge/contracts` (identity, beside
`WORKSPACE_FEATURES`):

| Use                | Sections it needs                          |
| ------------------ | ------------------------------------------ |
| `team-wiki`        | `workflows`                                |
| `engineering-docs` | `git`, `conflicts`, `captures`, `sources`  |
| `api-docs`         | `qa`, `git`, `sources`                     |
| `meeting-notes`    | `memos`, `captures`                        |
| `support-kb`       | `analytics`, `conflicts`, `sources`        |
| `public-docs`      | `analytics`, `sources`                     |

`assistant` and `knowledge-health` are in `ALWAYS_NEEDED_FEATURES`: no purpose
suggests them off.

Two pure functions carry the rule, pinned in
`apps/api/test/workspace-purpose.spec.ts`:

- `suggestedDisabled(uses)`: every section no chosen use needs. No uses
  suggests nothing off, which is the behaviour before this feature.
- `reconcilePurpose(previous, next, disabled)`: a section whose state still
  matches what the previous uses suggested follows the next suggestion. One
  that differs was set by hand: it stays, and is reported in `kept` when the
  next suggestion would have had it the other way.

**A new section joins the map.** A value added to `WORKSPACE_FEATURES` and to
neither a use nor `ALWAYS_NEEDED_FEATURES` is suggested off for every purpose.

## Storage

Three columns on `workspace_settings` (migration
`20270116170000_workspace_purpose`), no new model:

| Column                | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `purpose_uses`        | `text[] NOT NULL DEFAULT '{}'`, `WORKSPACE_USES` values              |
| `purpose_description` | The admin's own words, nullable                                      |
| `purpose_asked_at`    | When the question was confirmed or skipped; null = not yet asked     |

A use a later release drops reads as nothing (`isWorkspaceUse`).
`FeaturesService` (`apps/api/src/auth/features.service.ts`) reads the uses and
the asked flag through the same 30 s cache as the disabled list, and
`setPurpose` writes uses, description, the confirmed list and the stamp in one
upsert.

## Surfaces

| Surface                                    | What it does                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /v1/workspaces/:id/features`          | Every member and guest: now also `uses` and `purposeAsked`. Never the description                      |
| `GET /v1/workspaces/:id/purpose`           | Admin: uses, description, `askedAt`, `suggestedDisabled`, and the list actually `disabled`             |
| `PUT /v1/workspaces/:id/purpose`           | Admin: `{ uses, description?, disabled }` in one write. An unknown use or section is a 400. No uses with the list untouched is Skip |
| `POST /v1/workspaces/:id/purpose/interview`| Admin: one round of the interview (below). Writes nothing                                              |
| Settings → **Features**                    | A Purpose block above the section list (`FeaturesSettingsPage.vue`)                                    |
| `/setup/purpose`                           | The wizard (`PurposeSetupPage.vue`)                                                                    |

There is no MCP tool and no audit action for a purpose.

The web pieces live in `apps/web/src/modules/access`: `PurposeUses.vue` (the
checklist), `FeatureSections.vue` (the section list, which says when a row
will switch and when it differs from the suggestion) and
`model/purpose-draft.ts`, which holds an unsaved purpose. The draft's list is
`reconcilePurpose` over what is stored, with this session's own clicks on top.
Settings and the wizard mount the same three.

In Settings, a change that touches the purpose saves through `PUT …/purpose`.
A change to the checkboxes alone still saves through `PUT …/features`.

## The interview

`PurposeInterviewService` (`apps/api/src/workspace-purpose/`, an API-only
module of its own so the workspaces module does not import the assistant's).
The route is **not** `@Feature('assistant')`: it is how a workspace decides
which sections it has, so it cannot sit behind one.

It answers one of:

- `asking`: one more round of `choice` / `checklist` / `text` questions.
- `done`: the uses picked, a one-sentence reason for each, and
  `suggestedDisabled` for them.
- `unavailable`: the scaffolder agent is off, no provider resolves, or the
  budget is spent. Never a 5xx for these. A provider that fails mid-call is
  still an error.

The server caps it at `PURPOSE_INTERVIEW_MAX_ROUNDS` (3) rounds of
`PURPOSE_INTERVIEW_MAX_QUESTIONS` (3) questions. `finish` or the cap always
ends in `done`. It is stateless: the client sends every round back.

The pure half is `purpose-interview.ts`. The model is shown the uses with a
one-line brief each and never a section key. `readPicks` keeps only catalogue
values, so an invented use or a section key in the reply changes nothing. The
description and the transcript are wrapped untrusted. Usage is recorded as
`purpose-interview`.

The round shape, the answer type and the two pure functions (`readRound`,
`transcriptOf`) are shared with Describe it
([73](73-project-scaffolding.md)): the types sit beside `AssistantPromptField`
in contracts and the functions in `apps/api/src/assistant/interview-round.ts`.
An asker passes its own caps.

## First visit

`refusal` in `apps/web/src/app/router/index.ts` sends an admin of a workspace
with `purposeAsked` false to `/setup/purpose`, keeping where they were heading
in `?next=`. The flag comes from the features store the guard already awaits,
so the server render redirects too. Confirm and Skip both set the flag in the
store before navigating, so it cannot loop; a failed features read leaves the
flag true.

The page is an xstate machine (`model/purpose-machine.ts`): describe → rounds
→ review. `unavailable` or a failed call lands on review with nothing ticked.
Confirm saves through `PUT …/purpose`. Skip on a first visit saves no uses and
the untouched list, which only stamps the question. Opened from Settings
("Ask me a few questions instead") for a workspace already asked, leaving
writes nothing and Confirm reconciles against the current sections.

The demo workspace of `AUTH_MODE=none` has no `workspaces` row for the
migration to stamp, so the store treats it as asked.

## Not built

- No per-project purpose or per-project toggles.
- A purpose changes sections only: not lint policy, analytics recording,
  agents or budgets.
- The description enters no prompt other than the interview's own.
- No blueprint is suggested from the purpose.
- No MCP tools and no audit action.
- Nothing is re-suggested later from usage.
- A platform admin who opens someone else's never-asked workspace meets the
  wizard too, with Skip on every step.
