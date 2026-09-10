# 21 — Tagging an agent in a discussion

`@reviewer` in a review comment brings that agent into the thread. It reads the
discussion, the passage under it and the page, and replies as a comment in the
same thread.

The `@` menu already offered people and pages (feature 03) and eleven agents
already existed with instructions, tool allowlists and model routing (feature
20). What was missing was the wire between them: nothing on the API side ever
looked at a mention. The markup travelled into `merge_request_comments.body` as
inert text.

## Two columns

`ReviewThreadSource` (`'human' | 'ai'`) already existed, but it lives on the
**thread** and describes who opened it. That was enough while the only AI remark
was a whole review posted as its own thread — `ThreadCard` marked
`thread.source === 'ai' && i === 0`. An agent answering a mention replies *inside
somebody else's thread*, and `author_id` is the person who tagged it, so the
reply would have rendered under their name and their face.

So `merge_request_comments` and `document_comments` (deliberate twins, feature
15) each gained:

- **`agent_key`** — null when a person wrote it, otherwise which agent did.
  `author_id` stays the mentioner: they authorized the call and it bills to them.
- **`pending`** — the answer has not arrived yet.

`ThreadCard` now reads both per comment, and the thread-level `source` keeps
doing its narrower job.

## The pending comment is the claim

A model turn takes seconds to a minute; the request that triggers it is somebody
pressing **Comment**. So the reply is posted immediately as an empty `pending`
comment and filled in when the answer arrives. One row buys three things:

1. The reader sees the agent heard them, instead of nothing.
2. It is the idempotency guard. Re-saving an edited comment cannot fire a second
   reply — the insert is one guarded statement (`INSERT … SELECT … WHERE NOT
   EXISTS`), the shape `AgentFindingsService.claim()` uses to stop two presses
   opening two merge requests. A plain unique index cannot express it: the
   constraint is on *pending* rows only, and an agent may of course reply to a
   thread twice over the life of a review.
3. A reply that fails has somewhere to say so, rather than vanishing.

`MentionReplySweeper` (API-side, 1-minute tick, the `WorkflowMaterializeSweeper`
/ `ConnectorConflictSweeper` shape) closes out anything left pending past ten
minutes. A detached continuation is exactly what a deploy drops, and a
placeholder nobody will ever fill is worse than an error — it reads as progress.

`settle()` publishes `merge-request.comment.updated` / `document.comment.updated`
rather than a second `.created`: the card is already on screen, and a second
`.created` would read as a second remark. No activity row — `…comment.created`
was recorded when the mention was written, and an agent finishing its sentence is
not a separate thing that happened.

## Why there is no tool loop

The curator's reasoning (feature 20) applied to a narrower case: what an agent
needs to answer *"is this right?"* is the passage, the discussion and the page,
all of which are known exactly without asking a model to go and look. The call is
spent on the judgement rather than the retrieval.

It is also the only shape that does not distort the module graph.
`AssistantToolsService` needs `DocumentsService` and `MergeRequestsService`, so
`AssistantModule` imports `DocumentsModule` — and this service lives *in*
`DocumentsModule`. Reaching for tools from here means either a `forwardRef` that
claims the dependency runs both ways when it does not, or a second copy of the
three read tools, which is the duplication feature 20 deleted. If a reply ever
genuinely needs to search, the honest fix is extracting those tools over
`DocumentsCoreModule`.

`DocumentsModule` therefore imports `AgentCoreModule`, `AiCoreModule`,
`AssistantClientModule` and `EventsModule` — all Core/Client splits with no
controllers and no reach for `AccessService`, so none of them imports
`DocumentsModule` back.

## Specialists answer in their own shape

`reviewer` is the obvious agent to tag on a review, and its instructions promise
`{summary, issues[]}` — that is the contract `/v1/assistant/review` is built on.
Left alone it posted a wall of raw JSON.

The alternative was to refuse it: the chat picker's `conversational()` rule
excludes every built-in specialist. That would have made the most natural thing
to tag on a merge request the one thing you cannot tag. So the specialist keeps
answering in the shape it is good at, and `renderAnswer()` formats it — the same
transformation `AiCheckPane.asMarkdown()` already performs client-side on the
same agent's output, moved to the way *in* because a comment body has to be
markdown by the time it is stored: every later reader of it (the thread card, the
search index, the next agent to read the discussion) sees the stored text, not a
renderer. Prose passes through untouched.

Every gate is checked by name and reported in the reply — unknown agent, agent
disabled, no provider, not conversational, model missing a capability. This path
deliberately does not copy `resolveTurnAgent`'s fallback, which ignores `enabled`
(`20-agents-todo.md` §E).

## Both surfaces, on purpose

`CommentComposer` serves merge-request threads *and* page comments, and it sources
its own `@` targets. A chip that inserted on both and worked on one would be
worse than no chip, so `MentionRepliesService` is written against a
`MentionSubject` union and both thread services call it.

## Not the `'event'` run trigger

`20-agents-todo.md` §A reserves `AGENT_RUN_TRIGGERS` `'event'` for whenever
something real asks for it. This is deliberately **not** that. A mention is a
person addressing an agent in a conversation; it produces a comment, not an
`agent_runs` row with findings, and it has an owner by construction. §A still
wants the five `WorkflowTriggerService` guards and a real workload to hang them
on.

## Files

| | |
|---|---|
| Parser | `apps/api/src/documents/mentions.ts` (`parseAgentMentions`) |
| Turn + claim + render | `apps/api/src/documents/mention-replies.service.ts` |
| Recovery | `apps/api/src/documents/mention-reply.sweeper.ts` |
| Triggers | `merge-request-threads.service.ts`, `document-threads.service.ts` |
| Attribute | `AGENT_MENTION_ATTR` in contracts, re-exported by `lib/markdown/nodes.ts` |
| Editor | `AgentMention` in `extensions/inline.ts`, `nodes/AgentMentionNode.vue` |
| Menu | `RichEditor.vue` (`kind: 'agent'`), `CommentComposer.vue` (one computed) |
| Rendering | `ThreadCard.vue`, `use-agent-names.ts`, `.kn-mention-agent` in `editor.css` |

`currentLocale()` was added to `i18n/t.ts`: a detached continuation has no request
left for the ambient `t()` to read, so the locale is captured while there still is
one and handed back with `withLocale` — the same reason `import_jobs.locale` and
`workflow_runs.locale` are columns.
