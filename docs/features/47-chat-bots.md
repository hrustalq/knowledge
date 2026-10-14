# 47 — Chat bots

Issue [#71](https://github.com/hrustalq/knowledge/issues/71). People ask
questions in chat, not in the wiki. A workspace connects a messenger bot, and
the bot answers from the knowledge base with links to the pages it used.
Telegram ships first (phase 1). Every answer can be rated 👍/👎 and saved as a
page draft or a glossary term (phase 2). Channel notifications (phase 3), and
Slack and Teams (phases 4–5) are still open on the issue.

## Who an answer runs as

**Always a linked person.** There is no bot principal and no anonymous answer.
`ChatAnswersService` calls `AccessService.principalFor(userId, locale)` and then
`requireRole(…, 'viewer')` on **every** message. A person who was disabled, or
removed from the workspace, gets `chat.answer.noAccess` on their next question.
An account that is not linked gets the link instruction and nothing else: no
model call and no claim row.

**Linking needs two proofs.** Neither can be forged from the other:

1. **The account.** A link code is minted only in reply to a *verified*
   delivery from that messenger account, and only in a **private** chat. In a
   group the bot answers "message me privately" with a `t.me/<bot>` link and no
   code, because anyone in the group could open it and the account would then
   ask its questions as whoever clicked first.
2. **The person.** The code is redeemed at `/chat/link?code=` by a signed-in
   session that is a member of the bot's workspace. The page previews which
   account, which bot and which workspace before anything is linked.

`chat_link_codes` keeps only the SHA-256 of a code, which is single-use (spent
by a guarded `updateMany`) and expires after `CHAT_LINK_CODE_TTL_MINUTES`. A
new code for the same account deletes the unused ones. An account that is
already linked is **re-linked**: only its owner could have asked for the code.
The bot then says "linked" in the private chat, in the person's language.

## Groups

A group is silent until a workspace admin **binds** it, and then it is
`chat_channel_bindings`. An unbound group hears nothing, not even `/help`. That
stops a stray bot from being made to talk anywhere, and avoids amplifying spam.
A binding is created in one of two ways:

- `/bind` in the group, by a person whose linked account is a workspace
  **admin**, checked on execution. `/unbind` removes it.
- By chat id, under **Settings → Chat bots**.

Each binding sets:

- `answerMode`: `mention` (the default), `all` or `off`.
  - A reply to one of the bot's messages counts as a mention.
  - In `all` mode, an unaddressed message from an unlinked member is ignored
    rather than prompted to link.
- An optional `projectId`.
- An optional `agentKey`.
- An optional `locale`.

**The audience risk is stated, not solved.** An answer is computed with the
asker's ACL but shown to everyone in the group. While workspace membership is
the only read ACL, the exposure is "non-members in the group", and binding is
an admin asserting that the group's audience is fine. The settings page says so
next to the bindings. The *Page permissions* milestone must revisit this: answer
only from pages every linked member can read, use a per-binding audience user,
or send restricted answers by DM.

## The answer

**It runs in the API, not the worker.** That is a deliberate change from the
issue's plan. The turn is the pane's own `AssistantService.runChatTurn` (phase
0, #183). That service needs `AssistantToolsService`, which injects
`MergeRequestsService`, `StorageService` and `DocumentsService`, the API-only
half that the worker cannot load. So the chat answer uses the feature-21
@mention shape:

1. `POST /v1/chat/:id/webhook` (`@Public`):
   - Answers 404 while `CHAT_ENABLED` is off.
   - Compares `X-Telegram-Bot-Api-Secret-Token` in constant time against the
     stored SHA-256. A wrong secret is a 401 that logs the integration id and
     nothing else.
   - Hands each parsed message to `ChatAnswersService.receive` **detached**.
   - Returns 200 at once. Telegram redelivers what it thinks timed out.
2. `receive` resolves the binding, the identity and the reply language: the
   person's `users.locale`, then the binding's, then the bot's. Everything after
   that runs inside `withLocale`.
3. **Rate limit.** `CHAT_RATE_LIMIT_PER_USER_PER_MINUTE`, counted from the
   person's own claim rows in the last minute. There is no counter to keep in
   step. Over the limit, the person gets a "slow down" reply and no claim.
4. **The claim.** A `chat_answers` row inserted under
   `@@unique([integrationId, externalChatId, inboundMessageId])`. A redelivery
   hits the key and stops there.
5. **The placeholder.** "Searching…", posted as a reply to the question.
6. **The conversation.** One `chat_conversations` row maps to the asker's own
   `assistant_threads` row, so the history, sources and tool trace are in
   `/assistant`.
   - A reply to the bot's answer continues that answer's conversation, but only
     if it was the same person's.
   - A DM continues within 30 minutes of the last question.
   - Anything else starts fresh, and `/new` ages the person's conversations out.
   - A group conversation several people ask in is several threads, because a
     thread belongs to one person and its history would otherwise leak.
7. `runChatTurn(threadId, { content, agentKey, projectId }, principal)`:
   - **Ask mode** always, whatever the workspace's Agent switch.
   - **No pane-only tools**: `ask_user`, `render_component`, the mode switch.
   - **The binding's project** as a `search_knowledge` filter, pinned in the
     tool context. The graph expansion is skipped, because it walks the whole
     workspace.
   - A chat-style clause: short paragraphs, no tables.
   - Its implicit feedback signal lands under the `chat` answer surface.
8. **Settle first, then edit.** The claim is settled `pending → answered` with
   a guarded `updateMany`, and only then is the placeholder edited into the
   answer. If the reaper already failed the question, its "never arrived" stays
   and the answer is in `/assistant`.
9. `ChatAnswerSweeper` (API, 60 s tick, back-pressured, off while
   `CHAT_ENABLED` is):
   - Fails anything still `pending` after `CHAT_ANSWER_TIMEOUT_SECONDS`, with the
     same guarded update.
   - Edits its placeholder in the language frozen on the row.

The agent is `binding.agentKey ?? integration.defaultAgentKey ?? 'researcher'`.
`runChatTurn` reuses `resolveTurnAgent`, so an agent that is not conversational
in Ask mode, `author` included, falls back to the researcher. The settings
selects do not offer `author`.

Failures map to replies:

- A 429 from `assertWithinBudget` → `chat.answer.budget`.
- A `ForbiddenException` → `noAccess`.
- Anything else → `failed`.

The `operation` on the usage row is `chat`, billed to the asker.

## Rendering (Telegram)

The adapter owns the dialect: `parse_mode=HTML`, a 4096-character limit and
inline-keyboard buttons. `markdownToTelegramHtml` behaves as follows:

- It **escapes before adding any tag**, so page text cannot inject markup.
- Headings become bold lines and bullets become `•`.
- Relative page links (`/documents/:id`, the `PAGE_LINK_RULE` shape) resolve
  against `WEB_BASE_URL`. Non-http(s) targets drop to their text.
- `[S1, S2]` markers become numbered links to the cited pages.

Sources follow the answer: cited ones first, in citation order, up to
`CHAT_MAX_SOURCES`.

`cutAnswer` cuts an over-long answer at a paragraph or sentence boundary,
closes an open code fence and adds **Open the full answer** →
`/assistant?thread=<id>`. That page now honours `?thread=` as an opening
instruction.

If Telegram refuses the HTML, or a button URL (a localhost URL in development
is refused), the adapter resends once as plain text with the button targets
written out. "Message is not modified" on an edit counts as success. Errors
carry the method and Telegram's description, never the URL, which contains the
token.

## Feedback

Every answer carries a 👍 👎 row. A press comes back as an inbound with an
`action` (Telegram `callback_query`) and goes through the same `receive` path
as a question.

- **Who votes.** The presser, not the asker: in a group anyone the answer was
  shown to may rate it. The presser must be linked and still a member of the
  workspace (`principalFor` + `requireRole('viewer')` on the press). An
  unlinked presser is told to link privately; no code is issued from a press.
- **Where it goes.** `AnswerFeedbackService.vote(assistantMessageId, presser,
  { surface: 'chat' })` — the same `answer_feedback` table, one vote per
  person per answer, that the admin **Feedback** tab and the dataset export
  already read. The REST vote route still offers only the two panes; `chat` is
  written server-side only.
- **👎 then a reason.** The 👎 is recorded at once (a vote whose reason is
  never picked is still a vote), then the answer is re-rendered with the
  `ANSWER_FEEDBACK_REASONS` as buttons and a back button. A reason upserts the
  same row and the vote row comes back. In a group everyone sees the reason
  buttons for that moment, and a reason pressed by someone else is their own
  👎.
- **Re-rendered, not re-keyed.** The buttons change by editing the whole
  answer, rebuilt from the stored assistant message in the language it was
  asked in — only the adapter knows whether it cut the answer and added "Open
  the full answer", so the core cannot rebuild the keyboard alone.
- **Button data** is `chat-actions.ts`: `v:<chatAnswerId>:u|d`,
  `r:<chatAnswerId>:<reason>`, `b:<chatAnswerId>` — at most 57 bytes against
  Telegram's 64. It is decoded as untrusted input and the answer it names is
  looked up in the chat the press came from, so an id from another chat is
  "no longer available".
- **Acknowledged always.** The platform shows a spinner until the press is
  answered, so every press — undecodable, unlinked, forbidden — gets an
  `acknowledge`, with a short note only the presser sees. A press in a group
  unbound since the answer is still acknowledged.

## Saving a conversation

The vote row carries a third button, **💾 Save…**. It opens a menu — *As a
page draft*, *As a glossary term*, back — for a linked **editor** only: anyone
else is refused on the press and the menu never opens.

- **What is saved.** The conversation the answer belongs to, up to that
  answer, and **only the turns the bot posted in that chat** — read from
  `chat_answers`, not from the whole assistant thread, because the asker may
  have carried the thread on privately in `/assistant`. At most the newest 20
  turns. Citations become `[title](/documents/:id)` links, which the drafter
  keeps. The transcript reaches the model inside `wrapUntrusted(…, 'chat')`.
  Telegram's privacy mode means these are the only messages the bot ever saw,
  so this is also all it could save.
- **As whom.** The presser, through `principalFor`, with `editor` checked at
  the press and again after the draft is in and before anything is written.
- **Where it runs.** API-side, on the press's continuation — the answer
  shape, not the worker: the draft is one completion and publishing needs the
  API-only `MergeRequestsService`. `ChatModule` stays a single module.
- **Page.** The `drafter` agent (operation `chat-capture`) writes `# Title` +
  body. Then, in **one transaction**: `createDocument` with no content (main
  has no head, so nothing is published), `openDraftMergeRequest` onto
  `chat/<id8>-<ts>` with frontmatter `source: chat:<kind>` and
  `generatedBy: drafter`, attributed to the presser, and the claim's guarded
  `pending → published`. A merge request into a `main` with a null head
  fast-forwards — `merge()` parents the merge revision on the source head only
  (verified end to end on #71). A page goes into the group's project, or in a
  DM the workspace's first project.
- **Term.** `GlossaryService.suggest` over the transcript — the glossary
  page's own pass, grounding included — and the most-used suggestion the
  project does not define yet, created `source: 'ai'`, `enabled: false`: a
  proposal stays switched off (and therefore unlinked) until an editor turns it
  on in **Settings → Glossary**. Proposed and retired terms look the same
  there; a separate state would touch feature 14 and was not worth it yet.
- **The claim** is `chat_captures`, unique per (answer, kind): a second press
  while drafting is told it is in progress, a press after success links what
  was saved, and a press after a failure claims the same row again with a
  guarded `failed → pending` and retries.
- **The reply.** A "Drafting…" message replying to the answer, edited into
  the result with a button to the merge request or the glossary.
- **Crash recovery.** `ChatAnswerSweeper` also fails captures with no progress
  for `CHAT_CAPTURE_TIMEOUT_SECONDS` (measured from `updatedAt`, since a retry
  reuses the row) and edits "Drafting…" to say so. Because the publish commits
  with the guarded `published` update, a sweeper that got there first rolls
  the page and merge request back.

## The adapter seam

`chat/adapters/chat-adapter.types.ts` is the whole contract.

- **Inbound:** `verifyInbound`, `parseInbound` → `ChatInbound` (a message,
  or a button press in `action`).
- **Outbound:** `render(ChatAnswerView | ChatNoticeView)`, `postMessage`,
  `editMessage`, `acknowledge`. Buttons are rows of link buttons and action
  buttons; an action's data must fit `limits.maxActionBytes`.
- **Admin:** `identify` (Telegram `getMe`), `registerWebhook`, `directLink`.

The core decides *what* to say and the adapter decides *how* it looks and
travels. `ChatAdapterRegistry` is keyed by `ChatPlatformKind`, so a kind added
to `CHAT_PLATFORM_KINDS` without an adapter is a type error.
`CHAT_PLATFORM_KINDS` is `['telegram']` until another adapter ships, because a
closed vocabulary must not promise a value the code never emits.

What a later platform must map:

| Seam               | Telegram                                       | Slack (phase 4)                    | Teams (phase 5)                 | Mattermost / VK Teams       |
| ------------------ | ---------------------------------------------- | ---------------------------------- | ------------------------------- | --------------------------- |
| `verifyInbound`    | `secret_token` header, SHA-256 + constant time | `X-Slack-Signature` v0, 5-min skew | Bot Framework JWT               | outgoing-webhook token      |
| `parseInbound`     | `message`, reply chain, `@bot` mention         | `app_mention`, `message.im`        | `message` activity              | posted event / message      |
| button presses     | `callback_query` / `answerCallbackQuery`       | `block_actions`, then 200          | `Action.Submit` invoke          | interactive post action     |
| threads            | reply to the bot's message                     | `thread_ts`                        | `replyToId`                     | `root_id` / reply           |
| `render`           | HTML subset + inline keyboard                  | mrkdwn / Block Kit                 | Adaptive Card                   | markdown / inline keyboard  |
| `postMessage` / `editMessage` | `sendMessage` / `editMessageText`   | `chat.postMessage` / `chat.update` | `sendActivity` / `updateActivity` | `POST/PUT /posts`         |
| `registerWebhook`  | `setWebhook`                                   | manifest (manual)                  | Azure Bot (manual)              | manual                      |

## Admin surface

All of this is `admin` on the workspace. Two new `WorkspaceSource`s,
`chat-integration` and `chat-binding`, resolve ids in PG before the handler
runs.

- **Bots.**
  - `GET/POST /v1/chat/integrations` and `PATCH/DELETE …/:id`.
  - `POST …/:id/test` re-runs `getMe` and sets the webhook again.
  - **The token.** It is checked with `getMe` before anything is saved, stored
    in the secret box and returned only as `credentialHint`. One bot account
    serves one workspace (`@@unique([kind, botUsername])` → 409
    `chat.botTaken`).
  - **The webhook secret.** A fresh secret is minted on every registration and
    only its hash is kept.
  - **A refused webhook.** The refusal is stored on `webhook_error` and shown
    verbatim, rather than failing the save. A non-HTTPS `API_PUBLIC_URL` is the
    usual one in development.
- **Groups.** `GET/POST /v1/chat/integrations/:id/bindings` and
  `PATCH/DELETE /v1/chat/bindings/:id`. Every change saves as it is made.
- **People.** `GET /v1/chat/integrations/:id/identities` and
  `DELETE …/identities/:identityId`.
- **Me.**
  - `POST /v1/chat/link/preview` and `POST /v1/chat/link`. The code goes in the
    body, so it never lands in an access log.
  - `GET/DELETE /v1/me/chat-identities` act on your own rows only. Someone
    else's id reads as not found.
  - None of these routes carries `@Access`: there is no workspace in the
    request, so membership of the code's workspace is asserted explicitly.

The web pages are `/settings/chat` (`ChatSettingsPage.vue` +
`components/chat-bots/`), shown in the nav to workspace admins only,
`/chat/link` (`ChatLinkPage.vue`) and **Linked chat accounts** in
`ProfileSettingsPage.vue`.

## Bot commands

| Command     | Where   | Does                                                       |
| ----------- | ------- | ---------------------------------------------------------- |
| `/start`    | DM      | link instruction when unlinked, help otherwise             |
| `/help`     | any     | what the bot does and these commands                       |
| `/ask <q>`  | any     | a question, for groups where mentioning feels odd          |
| `/new`      | any     | start a fresh conversation                                 |
| `/unlink`   | DM      | disconnect this account                                    |
| `/bind`     | group   | answer here (linked workspace admin)                       |
| `/unbind`   | group   | stop answering here (linked workspace admin)               |

`/cmd@OtherBot` in a group is somebody else's command and is dropped.

## Telegram specifics

- **Privacy mode** (the default) shows a bot only the messages that mention
  it, reply to it, or are commands. That is exactly what it answers, and none
  of what it would otherwise read. It is also why Save works from the bot's
  own Q&A turns only.
- **Threads.** Groups have no threads, only reply chains, hence
  `replyToBotMessageId`.
- **Webhook only.** `allowed_updates: ['message', 'callback_query']`,
  `drop_pending_updates`. A bot registered before the feedback buttons
  existed is re-registered by **Test** or by saving its token again.
  Long polling for installs without a public URL is a follow-up.
- **Reaching Telegram.** `TELEGRAM_API_BASE_URL` points the outbound calls at
  a self-hosted Bot API server or a proxy. It is operator configuration, not a
  form field, so it is not run through `safe-url.ts`.

## Configuration

| Variable                              | Default                    | Meaning                                                             |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `CHAT_ENABLED`                        | `false`                    | master switch: off = webhook 404, no reaper; settings still editable |
| `CHAT_ANSWER_TIMEOUT_SECONDS`         | `120`                      | reaper threshold                                                    |
| `CHAT_MAX_SOURCES`                    | `5`                        | source links per answer (0–10)                                      |
| `CHAT_LINK_CODE_TTL_MINUTES`          | `15`                       | link code lifetime                                                  |
| `CHAT_RATE_LIMIT_PER_USER_PER_MINUTE` | `10`                       | questions per person per minute, across bots                        |
| `CHAT_CAPTURE_TIMEOUT_SECONDS`        | `300`                      | a save with no progress this long is failed                         |
| `TELEGRAM_API_BASE_URL`               | `https://api.telegram.org` | Bot API host (self-hosted server or proxy)                          |

## Data

All seven tables are new. None of them has an FK on `workspace_id`, `user_id` or
`created_by`, per house policy. The per-bot rows cascade with
`chat_integrations`.

| Table                   | Holds                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| `chat_integrations`     | bot: kind, name, token envelope + hint, inbound secret hash, username, webhook error, default agent, locale |
| `chat_channel_bindings` | group → project / agent / answer mode / locale                                |
| `chat_identities`       | messenger account → person, unique per bot                                    |
| `chat_link_codes`       | hashed one-time codes, with the private chat to confirm in                    |
| `chat_conversations`    | chat + asker → `assistant_threads` row                                        |
| `chat_answers`          | the claim: status, placeholder message id, assistant message id, frozen locale |
| `chat_captures`         | a save: answer + kind (unique), status, requester, "Drafting…" message id, the page / merge request / term it produced |

`chat_answers.assistantMessageId` is what 👍/👎 key on. Votes go into
`answer_feedback` under the `chat` surface (decided on #71), not into columns
of their own.

## Tests

- `test/chat-capture.spec.ts`:
  - The transcript keeps only the turns shown in the chat, with citations as
    page links; the draft's title comes from its first heading.
  - A page is drafted from the wrapped transcript (`chat-capture`), created
    empty, its body (with `source`/`generatedBy`) on a branch behind a merge
    request attributed to the requester; a DM uses the first project.
  - An editor demoted while drafting writes nothing; a sweeper that won
    rolls the publish back.
  - A double press saves once, a press after success links it, a press after
    a failure retries.
  - A term is the first new suggestion, created `source: 'ai'`,
    `enabled: false`; none new is said so; the sweeper reaps once.

- `test/chat-turn.spec.ts` (phase 0): Ask mode, tool list, project pin,
  surface.
- `test/chat-telegram.spec.ts`:
  - The secret check, normalisation, mentions, replies and commands.
  - Escaping, citations, links, cutting.
  - The plain fallback, and the token kept out of errors.
  - Button presses parsed; action buttons sent as callback buttons and kept on
    the plain fallback; `answerCallbackQuery`; the webhook asks for
    `callback_query`.
- `test/chat-identity.spec.ts`:
  - The code is hashed, expires and is single-use.
  - A non-member is refused before the code is spent.
  - Racing confirmations link once.
  - The webhook's 404, 401 and 200.
- `test/chat-inbound.spec.ts`:
  - An unlinked account gets no model call and no claim, and a code never goes
    into a group.
  - An unbound group is silent, and mention mode is enforced.
  - The binding's agent and project are used, and `/bind` needs an admin.
  - A redelivery answers once.
  - A removed person and the rate limit are both refused.
  - A failed turn fails the claim; a late answer loses to the reaper; the
    reaper edits once.
  - Button data round-trips within 64 bytes and decodes nothing it did not
    write.
  - 👍 votes as the presser on the `chat` surface; 👎 records at once and
    swaps in the reasons; a reason updates the same vote and restores the row;
    an unlinked or removed presser, an answer from another chat and feedback
    switched off record nothing and are still acknowledged.
  - Save opens the menu for an editor only; a choice restores the vote row and
    starts the capture as the presser in the group's project; a viewer pressing
    an old menu starts nothing.
