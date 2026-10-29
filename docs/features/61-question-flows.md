# 61 — Question flows: one question at a time, in the chat and over MCP

Issue [#425](https://github.com/hrustalq/knowledge/issues/425), shipped as four
PRs (#435, #436, #437 and the one carrying this document). Before it, a
wide-reaching task either guessed what the model was not told or wrote the
options out as prose. The assistant pane had one-shot `ask_user` forms with no
notion of a sequence, and MCP had nothing: `knowledge_capture_decision` without
a `projectId` was a validation error, and the person at the keyboard was never
asked.

Now two tasks ask before they write, one question at a time:

- **Capture a decision**: which project → which related page → who reviews it
  (the reviewer only when a page is linked).
- **Mark a page outdated**: this page or its subtree → which subpages to leave
  alone (only for the subtree) → why.

The questions are the same everywhere. Only the way they reach the person
differs (product principle 4: the agent interface and the human interface are
the same product).

| Surface | How the question reaches the person | How the answer comes back |
| --- | --- | --- |
| Web assistant pane | A `prompt` frame: one form, "Question n of m" | The next user message, carrying `answer` |
| MCP client with a form (stdio, `elicitation` declared) | `elicitation/create`, inside the open tool call | The client's `accept` / `decline` / `cancel` |
| Any other MCP client (every HTTP caller) | The tool returns `status: "needs_input"` | The agent asks with its own question tool and calls again with `answers` |

## What

- **The questions are code; the options are the caller's workspace data.**
  Projects the caller may capture into, pages search finds for the title
  (only pages they can open), the workspace's editors with the linked page's
  owner first. The model never writes an option, and a value that was not on
  offer fails validation, so an answer can never reach past what the person
  could have picked.
- **One option is recommended**: the first project, the page the caller
  suggested (or "No link"), the page's owner, "This page only". The web
  pre-selects it, so confirming is one Enter; the elicitation form makes it
  the `default`; `needs_input` marks it `recommended: true`.
- **Nothing is written while a question is open.** A declined or cancelled
  question ends the flow, and nothing is written. A skipped optional question
  records `null`.
- **Changing an earlier answer drops what stopped applying.** Answer "No link"
  after picking a reviewer and the reviewer question is dropped and reported,
  never silently kept. The web strikes it through as *Dropped*.
- **With every argument given, nothing is asked.** `projectId` on a capture,
  or a `note` on a page with no subpages, runs the task as before.
- **The free-form `ask_user` stays** for the model's ad hoc questions. Its
  options gained `recommended`, and its description asks for one question per
  form.

## Decisions

### A flow is rebuilt from its answers alone

`@knowledge/contracts/flows` holds the model as pure functions:

- `nextQuestion(scenario, answers)` is the open question, with its `step` and
  `of`;
- `validate(question, value)` checks and normalizes one answer;
- `prune(scenario, answers)` keeps what still counts and reports the rest.

The same answers always yield the same next question, so there is **no flow
state table**. A reloaded web thread, a retried MCP call and a crash halfway
through all land on the same question. The web rebuilds the bag from the
thread's messages (`flow-chain.ts`); an MCP agent sends the whole bag back
each call.

The walk is strictly sequential. An answer to a question after the open one
is dropped as `not-yet-asked`, never applied out of order. Each drop carries a
reason: `not-applicable` (an earlier answer ruled the question out),
`invalid`, `not-yet-asked` or `unknown`.

A question's `when` predicate is written to hold until an answer rules it out
(`a.relatedPage !== NO_LINK`, not `a.relatedPage === X`). That keeps
"Question n of m" an upper bound that only shrinks, never one that grows under
the person.

### One server half, three transports

`FlowsService` (`apps/api/src/flows/`, controller-free, API-side because a
capture opens a merge request) fills a scenario's options under the caller's
`AccessScope`, walks it, and runs the task once nothing is open. It returns a
`FlowRun`: `needs_input` with the step and the drops, or `done` with the
task's result. The assistant tools (`capture_decision`, `mark_outdated`) and
the MCP tools call the same two methods; each transport only maps a
`needs_input` run.

### The web: an answer travels structured

Each question is one assistant turn that ends on a `prompt` frame. The
`AssistantFormPrompt` carries `flow`, `questionId`, `step` and `of`, and its
options carry `recommended`. The answer goes back as
`PostAssistantMessageDto.answer = { flow, questionId, value }` beside the
readable `Label: value` text, and is stored on the user message
(`assistant_messages.answer`, migration `20261130100000_assistant_message_answer`).
The API never parses labels.

**Only the open question, or the one answered last, takes an answer.** That
is what *Change* re-answers. An older form submitted late is refused with 409
`{ reason: 'flow-answer-stale' }` before the message is stored. Answers reach
a tool only through `ctx.flow`, never from the model's arguments: a
`projectId` the model restates inside a flow is ignored.

The transcript's step state (answered, changeable, dropped) is derived
client-side by `apps/web/src/entities/assistant/model/flow-steps.ts` from the same messages, so the
prompt frame carries no `dropped` list. An answered step collapses to one line
("Project: Platform ✓"). A question, its answer and a flow's outcome are quiet
turns: no confidence badge, no thumbs, no message actions, and a tool row
reads *asked* or *failed*, never success wording for a question.

### MCP: elicitation needs a session, and HTTP has none

`mcp.controller.ts` serves Streamable HTTP **statelessly on purpose**
(`sessionIdGenerator: undefined`, GET answers 405). It builds a fresh server
per request, so it can never send a request back to the client, and no HTTP
caller can be elicited. **`needs_input` is therefore the first-class path, not
a fallback.**

`runFlow` (`apps/api/src/mcp/flow-tools.ts`) maps a run:

- The client declared form elicitation (`getClientCapabilities()?.elicitation?.form`,
  which only a stdio client can have here): each open question is sent with
  `elicitInput`. On `accept` the answer is folded back and the flow continues
  in the same call. On `decline` or `cancel` the reply is
  `{ status: 'cancelled', flow, question, wrote: 'nothing' }`. The request
  waits up to 15 minutes, since a form waits on a person; after ten
  elicitations in one call it falls back to `needs_input`.
- Otherwise the reply is `{ status: 'needs_input', flow, step, of, question,
  answersSoFar, ignored?, next }`. `question` is the open question as the scenario
  defines it (`id`, `type`, `label`, `required` when set, `options` with
  `recommended`); its `when` predicate is code and does not serialize.
  `ignored` lists the keys of the caller's `answers` that `prune` set aside,
  with their reasons. `next` tells the agent what to do in one sentence.

`answers` (question id → a string, an array of strings, or `null`) is an
optional argument of `knowledge_capture_decision` and `knowledge_flag_document`.
It is not a write of its own: it joins no list in `mcp-tools.ts`, and the
tools keep their places in `CAPTURE_TOOLS` and `WRITE_TOOLS` and their guards.
`MCP_INSTRUCTIONS` and the generated SKILL.md (*Questions for the person*,
offered only to a key that has one of the two tools) teach the loop.

`knowledge_flag_document` asks only for `state: "outdated"`. `requested` is
unchanged. The flow writes through knowledge health's bulk action, and the
flag still records `source: { kind: 'mcp' }`. The workspace comes from the
page, never from the `workspaceId` argument.

### An elicitation schema is flat and primitive-only

Two constraints of the MCP elicitation schema (string, number, boolean, enum;
no arrays, no nesting) shape `toElicitationSchema` and its inverse
`fromElicitation`:

- **A checklist cannot be an array**, so it is one boolean per option, keyed
  by the option value, the recommended ones defaulting to `true`. It folds
  back to the array of ticked values, which is exactly what the web sends.
- **A required enum cannot sit beside an "other" box.** A question that
  allows "other" is sent optional with a `_other` string beside it, and
  `validate` checks that one of the two came back.

An accepted form with the field left empty is a skip (`null`). For a required
question `validate` refuses it, and the question is asked again.

## Where it lives

| Piece | Path |
| --- | --- |
| Model, scenarios, elicitation mapping | `packages/contracts/src/flows/index.ts` |
| Prompt shape (`flow`, `step`, `of`, `recommended`) | `packages/contracts/src/ai/index.ts` |
| Options, walk, task | `apps/api/src/flows/flows.service.ts` |
| Assistant tools and the form | `apps/api/src/assistant/assistant.tools.ts` (`flowQuestion`) |
| The open flow, rebuilt from a thread | `apps/api/src/assistant/flow-chain.ts` |
| Stale-answer refusal | `apps/api/src/assistant/assistant.service.ts` |
| Question labels (en, ru) | `apps/api/src/i18n/{en,ru}/flow.json` |
| MCP mapping | `apps/api/src/mcp/flow-tools.ts`; the tools in `capture-tools.ts` and `mcp.service.ts` |
| Web form and transcript | `apps/web/src/entities/assistant/components/AssistantPrompt.vue`, `ChatMessage.vue`, `apps/web/src/entities/assistant/model/flow-steps.ts` |

## Not done

- **Chat bots never start a flow.** Telegram and Time keep
  [feature 47](47-chat-bots.md)'s "no pane tools" rule.
- **No model-authored wizards.** The model may ask ad hoc with `ask_user`; a
  flow's questions are code.
- **No stateful MCP HTTP session**, so HTTP clients are never elicited.
  Revisit only if a client proves unable to run the `needs_input` loop.
- **Option lists are capped, not paged**: 20 projects, 6 pages, 20 reviewers.
  A subtree of more than 50 pages is not offered; only the page itself is
  marked, and the reply says to use knowledge health for the rest.
- **The one-shot `/assistant/ask` endpoint and the editor assistant**
  ([feature 34](34-editor-assistant.md)) have no flows.

## Verification

- Unit (`apps/api/test/`):
  - `question-flows.spec.ts`: `validate`, `prune`, `nextQuestion`, the two
    scenarios, and the elicitation round trip;
  - `assistant-flows.spec.ts`: the flow rebuilt from a thread, the stale-answer
    rule, a flow tool asking instead of running, answers from the harness
    winning over the model's;
  - `mcp-http.spec.ts`: `needs_input` without `projectId`, the same answers
    giving the same question, a skip-ahead key reported under `ignored`; a
    decline over an eliciting client writing nothing; accepted forms running
    the capture; a checklist elicited as booleans and folding back to the
    same bulk call an `answers` bag makes; the skill section offered only with
    a flow tool.
- Web: `apps/web/src/entities/assistant/model/flow-steps.spec.ts` (step state, *Change*, dropped
  steps).
- By hand against the local stack:
  - `POST /v1/mcp` with curl: `needs_input` for the project, the same reply
    byte for byte for the same `answers`, `reviewer` and an unknown key
    reported as ignored, the project answer moving to question 2 of 3.
  - The stdio entrypoint (`node dist/mcp.main.js`) driven by an SDK client
    that declares elicitation and declines: `cancelled`, and the
    `knowledge_captures` and `merge_requests` row counts unchanged.
  - The web pane in Chrome: one question per turn, Enter on the recommended
    option, reload mid-flow showing the same open question.
