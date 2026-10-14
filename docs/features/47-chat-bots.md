# 47 — Chat bots

Issue [#71](https://github.com/hrustalq/knowledge/issues/71). People ask
questions in chat, not in the wiki. A workspace connects a messenger bot, and
the bot answers from the knowledge base with links to the pages it used.
Telegram ships first (phase 1). Feedback and saving a thread as a page (phase
2), channel notifications (phase 3), and Slack and Teams (phases 4–5) are still
open on the issue.

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

## The adapter seam

`chat/adapters/chat-adapter.types.ts` is the whole contract.

- **Inbound:** `verifyInbound`, `parseInbound` → `ChatInbound`.
- **Outbound:** `render(ChatAnswerView | ChatNoticeView)`, `postMessage`,
  `editMessage`.
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
  of what it would otherwise read. Phase 2's "save thread" will be limited by
  this.
- **Threads.** Groups have no threads, only reply chains, hence
  `replyToBotMessageId`.
- **Webhook only.** `allowed_updates: ['message']`, `drop_pending_updates`.
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
| `TELEGRAM_API_BASE_URL`               | `https://api.telegram.org` | Bot API host (self-hosted server or proxy)                          |

## Data

All six tables are new. None of them has an FK on `workspace_id`, `user_id` or
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

`chat_answers.assistantMessageId` is what phase 2's 👍/👎 key on. Votes go
into `answer_feedback` under the `chat` surface (decided on #71), not into
columns of their own.

## Tests

- `test/chat-turn.spec.ts` (phase 0): Ask mode, tool list, project pin,
  surface.
- `test/chat-telegram.spec.ts`:
  - The secret check, normalisation, mentions, replies and commands.
  - Escaping, citations, links, cutting.
  - The plain fallback, and the token kept out of errors.
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
