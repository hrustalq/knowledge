# 47 — Chat bots

Issue [#71](https://github.com/hrustalq/knowledge/issues/71). People ask
questions in chat, not in the wiki. A workspace connects a messenger bot, and
the bot answers from the knowledge base with links to the pages it used.
Telegram ships first (phase 1). Every answer can be rated 👍/👎 and saved as a
page draft or a glossary term (phase 2). A bound group can be told when pages
are published or updated and merge requests opened or merged (phase 3). Time,
T-Bank's self-hosted corporate messenger, is the second platform (phase 4): the
same answers, linking, feedback, saving and notifications, heard over the bot's
own websocket instead of a webhook (see **Time specifics**). Mattermost
(#343) is the third, through the same adapter as Time (see **Mattermost
specifics**). Since #82 a
linked editor can also ask the bot to **harvest** a thread of people's
messages into reviewed captures; that is its own document,
[59 — Chat harvest](59-chat-harvest.md).

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
   - On Time this route only ever receives **button presses**; messages arrive
     over the websocket held by `ChatSocketSupervisor`, which hands each one to
     the same `receive`.
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

Since #82 both are **agent-memory captures** (doc 50): one save path, one
dedupe, one inbox. `ChatCapturesService` builds the request and hands it to
`CapturesModule`; the capture carries `session.client: 'chat'` and a
server-set `origin` (platform, chat title — null in a DM — and the span from
the question to the answer).

- **As whom.** The presser, through `principalFor`, with `editor` checked at
  the press and again by `CaptureService` before anything is written.
- **Page.** The answer becomes an `answer` capture through
  `CaptureInboxService.fromAssistantMessage` — exactly the assistant pane's
  "Save to knowledge base": the question before it, the answer with its `[S#]`
  labels stripped, and its page sources as citations. An answer that cites no
  page is refused. No model is called. Dedupe decides between a duplicate, an
  amendment and a hidden new page behind a merge request with provenance
  `captured`; the group's project is passed when there is one, otherwise the
  first cited page's.
- **Term.** `GlossaryService.suggest` over the conversation — **only the
  turns the bot posted in that chat**, read from `chat_answers` (the asker may
  have carried the thread on privately in `/assistant`), the newest 20, inside
  `wrapUntrusted(…, 'chat')` — and the most-used suggestion the project does
  not define yet becomes a `glossary` capture that waits in the Captures inbox.
- **The reply.** One message replying to the answer, with a button to the
  merge request, the page a duplicate matched, or the inbox. It never names a
  matched page: the group may hold people who cannot open it. A refusal (no
  cited page, a credential, the capture rate limit, captures switched off)
  gets its own line.
- **Double press and crash recovery** are the capture path's: a second press
  is a `duplicate` row, and the capture sweeper re-drives a staged row a
  restart stranded.

Save keeps what the bot said. Keeping what the people in a thread settled is
the **harvest** (`capture`, `/capture`, 📌 on Time, ✍ on Telegram), which
writes the same captures through the same path:
[59 — Chat harvest](59-chat-harvest.md).

## Channel notifications

Each bound group can carry notification rules (`chat_subscriptions`): what to
report (`page-published`, `page-updated`, `merge-request-opened`,
`merge-request-merged`), where (a project, or the whole workspace; optionally
pages carrying any of some tags) and when (right away, or an hourly / 4-hourly
/ daily digest).

- **Only titles and links.** A group's members need not be workspace members,
  so nothing of a page's content is posted — a label, the page or merge
  request title, and a link that still asks for sign-in. Creating a rule needs
  `admin`, like binding the group did.
- **The feed is `activity_log`, not the event bus.** Pub/sub forgets whatever
  a restart missed; the table does not, and a digest is a query over rows that
  already exist. Rows are filtered in SQL by workspace, project and the actions
  the rule's kinds are read from (`chatActionsFor`, the inverse of
  `chatEventKindFor` in contracts).
- **What a row means** is derived, never stored. A `revision.finalized` counts
  only on the page's default branch — a draft on a review branch is nobody's
  news until it merges — and is `page-published` when it is the first
  non-draft revision there (a merge into an empty, chat-saved page reads that
  way too), `page-updated` otherwise. With a merged rule, the revision a merge
  request landed is reported once, as the merge. Within one message a page is
  one line: five edits are one "updated", published-then-edited is one "new
  page". Archived pages and pages outside the workspace are dropped.
- **Tags** are matched in the graph (`GraphService.getDocumentIdsByTags`,
  inside the rule's workspace) and stored folded like tag entity keys. A tag
  reaches the graph only when a revision is indexed, so a tagged rule **holds
  its cursor** before a revision that is still indexing and retries next tick;
  after 10 minutes it judges the row on the tags the graph has.
- **The cursor** is `(cursor_at, cursor_id)`, the last activity row read, and
  starts at the rule's creation (a new rule is not a replay). Rows younger than
  5 s are left for the next tick, because a row stamped earlier can commit
  after one stamped later. A rule never looks back further than 24 hours, so
  a bot switched off for a week does not replay the week.
- **At most once.** `ChatSubscriptionsService.deliver` moves the cursor in one
  guarded `updateMany` (from where it read it) **before** posting, so two
  sweeps or two API processes never send the same rows. A post the platform
  refuses puts the cursor back (guarded again) and records the refusal on
  `last_error`, shown under the rule. A crash between the claim and the post
  loses that one message — the trade for never sending one twice.
- **One message per rule per tick.** One event reads as one line; more get a
  heading (`N updates in <project>`), a digest gets its own heading, and past
  20 lines the rest is counted. Messages use the group's language, then the
  bot's.
- **Where it runs.** `ChatSubscriptionSweeper`, API-side beside the answer
  sweeper, every `CHAT_DIGEST_TICK_MS`, never a second sweep while one runs,
  off while `CHAT_ENABLED` is. The issue's design put it in the worker; the
  token and the adapters already live in the API, and a post to a group is
  attributed to nobody, so it stayed in the one `ChatModule`. Due rules are
  selected in SQL: instant rules always, digests once `next_due_at` has
  passed, bots switched off never.

The web editor is `components/chat-bots/ChatSubscriptionEditor.vue`, opened
from **Notifications (n)** under each group in `ChatBindingTable.vue`. Its tag
field is the search sheet's (`lib/tag-options.ts`).

## The adapter seam

`chat/adapters/chat-adapter.types.ts` is the whole contract.

- **Inbound:** `verifyInbound`, `parseInbound` → `ChatInbound` (a message,
  or a button press in `action`). `inbound` says whether messages come to the
  webhook (Telegram) or over the bot's websocket (Time, Mattermost). `threadId` is set on a
  platform with real threads. For a harvest (#82) an inbound also carries `at`,
  `replyTo` (the message it replies to, raw, never stored), `forwardedFrom`,
  `topicId`, and `harvestReaction` when it is a reaction rather than a message.
- **Press replies:** `acknowledge`, plus the optional `respondToAction` for a
  platform that answers a press in the HTTP response (Time, Mattermost) rather than with a
  call of its own (Telegram's `answerCallbackQuery`).
- **Outbound:** `render(ChatAnswerView | ChatNoticeView | ChatUpdatesView)`, `postMessage`,
  `editMessage`, `acknowledge`. Buttons are rows of link buttons and action
  buttons; an action's data must fit `limits.maxActionBytes`.
- **Admin:** `identify` (Telegram `getMe`), `registerWebhook`, `directLink`.
- **Harvest (optional, #82):** `fetchThread` (Time, Mattermost: a whole thread by any post
  in it) and `messageUrl` (Telegram: a supergroup message's `t.me/c/…` link).
  Telegram has no `fetchThread`; its threads come from `ChatBufferService`.

The core decides *what* to say and the adapter decides *how* it looks and
travels. `ChatAdapterRegistry` is keyed by `ChatPlatformKind`, so a kind added
to `CHAT_PLATFORM_KINDS` without an adapter is a type error.
`CHAT_PLATFORM_KINDS` is `['telegram', 'time', 'mattermost']`: VK Teams joins
it only with its adapter, because a closed vocabulary must not promise a
value the code never emits. `CHAT_SELF_HOSTED_PLATFORMS` (`['time',
'mattermost']`) is the one list the form, the DTO check and the service read
for "this bot needs a server address". Time and Mattermost are **one adapter**,
`MattermostAdapter` (`chat/adapters/mattermost.adapter.ts`), constructed once
per kind; `CHAT_SOCKET_KINDS` in the registry is the list of kinds the socket
supervisor holds, and `registry.socket(kind)` hands it the right instance.

How each platform maps, and what a later one must:

| Seam               | Telegram                                       | Time (phase 4) and Mattermost (#343)                   | VK Teams                    |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------ | --------------------------- |
| inbound            | webhook                                        | websocket `GET /api/v4/websocket`, `posted` events     | long poll `events/get`      |
| `verifyInbound`    | `secret_token` header, SHA-256 + constant time | HMAC over the button's data in `integration.context`   | —                           |
| `parseInbound`     | `message`, reply chain, `@bot` mention, `message_reaction` (✍) | `posted`: `@bot` in the text, `channel_type: 'D'`; `reaction_added` (📌) | message                     |
| button presses     | `callback_query` / `answerCallbackQuery`       | POST to `integration.url`; note as `ephemeral_text` in the response (`respondToAction`) | —                           |
| threads            | reply to the bot's message                     | `root_id` (`threadId`)                                 | reply                       |
| `render`           | HTML subset + inline keyboard                  | markdown + one attachment of `actions` per button row  | markdown / inline keyboard  |
| `postMessage` / `editMessage` | `sendMessage` / `editMessageText`   | `POST /api/v4/posts` / `PUT /api/v4/posts/:id/patch`   | —                           |
| `identify`         | `getMe`                                        | `GET /api/v4/users/me`                                 | `self/get`                  |
| `registerWebhook`  | `setWebhook`                                   | no-op (the supervisor opens the socket)                | manual                      |

## Admin surface

All of this is `admin` on the workspace. Three new `WorkspaceSource`s,
`chat-integration`, `chat-binding` and `chat-subscription`, resolve ids in PG
before the handler runs.

- **Bots.**
  - `GET/POST /v1/chat/integrations` and `PATCH/DELETE …/:id`.
  - `POST …/:id/test` re-runs `getMe` and sets the webhook again.
  - **The token.** It is checked with `getMe` before anything is saved, stored
    in the secret box and returned only as `credentialHint`. One bot account
    serves one workspace (`@@unique([kind, serverUrl, botUsername])` → 409
    `chat.botTaken`; the server is part of it because Time names bots per
    server, and it is `''` for Telegram so that rows' uniqueness holds).
  - **The server** (Time, Mattermost). Required for a self-hosted kind and refused for any
    other; normalised, and checked by `assertSafeExternalUrl` with
    `CHAT_ALLOW_PRIVATE_URLS` as the private-network switch. Every later call
    and the websocket dial resolve it again through the SSRF guard.
  - **The webhook secret.** A fresh secret is minted on every registration and
    only its hash is kept.
  - **A refused webhook.** The refusal is stored on `webhook_error` and shown
    verbatim, rather than failing the save. A non-HTTPS `API_PUBLIC_URL` is the
    usual one in development.
- **Groups.** `GET/POST /v1/chat/integrations/:id/bindings` and
  `PATCH/DELETE /v1/chat/bindings/:id`. Every change saves as it is made.
- **Notifications.** `GET/POST /v1/chat/bindings/:id/subscriptions` and
  `PATCH/DELETE /v1/chat/subscriptions/:id`. A digest without a window is a
  400; changing the timing starts a new window.
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
| `/capture`  | any     | harvest a thread: in a group as a reply to its first message, in a DM after forwarding it (linked editor; [59](59-chat-harvest.md)) |
| `/forget`   | any     | delete the messages of yours the bot keeps for harvesting  |

`/cmd@OtherBot` in a group is somebody else's command and is dropped.

On Time the commands are the same words **without the slash** — `help`, `new`,
`unlink`, `bind`, `unbind`, and `capture` (also `remember` or `запомни`, said
inside the thread) — sent as a whole message (in a channel, after
mentioning the bot): Time's client takes every leading `/` as its own slash
command and never posts it. `/ask` is not needed there, a mention is the
question. The help text is per platform (`chat.help` / `chat.helpTime`).
Mattermost is the same: its client claims a leading `/` too, so it gets the
plain-word commands and `chat.helpTime`.

## Telegram specifics

- **Privacy mode** (the default) shows a bot only the messages that mention
  it, reply to it, or are commands. That is exactly what it answers, and none
  of what it would otherwise read. It is also why Save works from the bot's
  own Q&A turns only. A group that keeps messages for a harvest (#82) needs
  privacy mode off, or the bot made a group admin.
- **Threads.** Groups have no threads, only reply chains, hence
  `replyToBotMessageId`.
- **Webhook only.** `allowed_updates: ['message', 'callback_query',
  'message_reaction']`, `drop_pending_updates`. Telegram sends reactions only
  where the bot is a group admin. A bot registered before the feedback buttons
  or ✍ (#82) existed is re-registered by **Test** or by saving its token again.
  Long polling for installs without a public URL is a follow-up.
- **Reaching Telegram.** `TELEGRAM_API_BASE_URL` points the outbound calls at
  a self-hosted Bot API server or a proxy. It is operator configuration, not a
  form field, so it is not run through `safe-url.ts`.

## Time specifics

Time is T-Bank's corporate messenger, hosted by each customer, with
Mattermost's `/api/v4`. The adapter is `MattermostAdapter`
(`chat/adapters/mattermost.adapter.ts`), constructed with the kind `time`; the
payload shapes are Mattermost's, which Time's documentation follows. They were
built against that documentation and Mattermost-shaped fixtures, then checked
against a live Mattermost server (#343, see **Mattermost specifics**). **No
live Time server has been tried**: what Time does differently from Mattermost,
if anything, is still unknown.

- **A bot account and a server.** An admin creates the bot under Integrations
  → Bot accounts in Time and pastes its token with the server address. The
  token is checked with `GET /api/v4/users/me` before anything is saved.
- **Hearing: a websocket, not a webhook.** `ChatSocketSupervisor` (API-side,
  only while `CHAT_ENABLED`) holds one socket per enabled Time bot,
  authenticated with the `Authorization` header, and hands each `posted`
  event, and each 📌 `reaction_added` (#82), to `ChatAnswersService.receive`.
  - Every `CHAT_SOCKET_SYNC_MS` it compares the sockets with the enabled bots:
    a bot saved, switched off, given a new token or moved is picked up.
  - A dropped socket reconnects with backoff (1 s → 60 s), reset by the
    server's `hello`. We ping every 30 s; 75 s of silence is a dead socket.
  - Its state is written to `webhook_error` (only on change), which is what
    the settings card shows; **Test** reports it rather than overwriting it.
  - **Every replica holds every socket**, and Time sends each of them every
    message. The post id is claimed in Redis (`SET NX`, 1 h) before anything
    is done, so a help or link reply goes out once, not once per replica; an
    answer is single through its `chat_answers` row besides. A 📌 is claimed
    as `<post>:pin:<user>`, apart from its post. With Redis down
    the claim is skipped rather than the bot going silent.
  - **No catch-up.** Time documents none, so a message sent while no socket
    is open is not answered.
- **Threads.** Time has real ones. In a channel the bot answers in the
  question's thread; a later message in a thread it answered in is addressed to
  it without a mention, and continues the asker's conversation
  (`chat_answers.thread_id`). In a direct chat it answers at the top, unless
  asked inside a thread. Time refuses a `root_id` that is itself a reply, so
  the adapter reads the message it replies to for its root.
- **Buttons.** Each row of action buttons is an attachment of `actions`; link
  buttons become a line of links under the text, because Time's buttons only
  call back. A press POSTs to the button's `integration.url` — our webhook —
  with the `context` it was given and nothing that proves who sent it, so the
  context carries an HMAC over the data keyed by the bot token; a forged,
  re-targeted or another bot's context is a 401. The press's note is the
  `ephemeral_text` of the HTTP response: `respondToAction` holds it until the
  core's `acknowledge` (at most 5 s). Re-rendering is the core's own edit.
- **Mentions are defused.** `@channel`, `@all` or a colleague's handle quoted
  in an answer, a page title or a notice gets a zero-width space after the
  `@`, so it reads the same and pings nobody.
- **No deep link.** Opening a DM with a bot needs the team name, which a bot
  does not have; a group asks people to message the bot instead.
- **Reachability both ways.** The API must reach the Time server (REST and the
  websocket), and the Time server must reach `API_PUBLIC_URL` for buttons.

## Mattermost specifics

Mattermost (#343) is Time without the rebrand: the same `MattermostAdapter`,
constructed with the kind `mattermost`. Everything under **Time specifics**
holds — the websocket, the Redis claim, threads, signed buttons, defused
mentions, plain-word commands, 📌 as the harvest reaction, no deep link. The
kind only names the platform: in the setup form and the bot card, in error
labels (`mattermost GET /users/me: …`) and in a capture's origin.

- **A bot account and a server.** A system admin enables bot accounts
  (System Console → Integrations → Bot Accounts); an admin then adds one under
  Integrations → Bot Accounts and copies its access token. The form takes it
  with the server's address.
- **The bot must be in the team and the channel.** Mattermost delivers a
  channel's `posted` and `reaction_added` events only to its members.
- **Buttons on a private network.** Mattermost refuses to call an
  `integration.url` on a private address unless its
  `ServiceSettings.AllowedUntrustedInternalConnections` lists the host, so a
  self-hosted pair on one LAN needs that set for 👍/👎 and Save to work.
  Without it the press fails in Mattermost with "address forbidden" and never
  reaches the API.
- **Checked live.** #343 ran the adapter and `ChatSocketSupervisor` (real `ws`
  dial, Bearer header) against a `mattermost/mattermost-preview` container:
  `identify`, the websocket `hello`, a channel mention, `help`, a DM `new`, the
  bot's own post not handed back, the reply in the question's thread, a press
  verified and answered with `ephemeral_text`, an edit clearing the buttons,
  📌 handed on and ✅ ignored, `capture` in a thread, and `fetchThread` with the
  team permalink. The fixtures in `chat-mattermost.spec.ts` match what it sent.

## Configuration

| Variable                              | Default                    | Meaning                                                             |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `CHAT_ENABLED`                        | `false`                    | master switch: off = webhook 404, no reaper; settings still editable |
| `CHAT_ANSWER_TIMEOUT_SECONDS`         | `120`                      | reaper threshold                                                    |
| `CHAT_MAX_SOURCES`                    | `5`                        | source links per answer (0–10)                                      |
| `CHAT_LINK_CODE_TTL_MINUTES`          | `15`                       | link code lifetime                                                  |
| `CHAT_RATE_LIMIT_PER_USER_PER_MINUTE` | `10`                       | questions per person per minute, across bots                        |
| `CHAT_DIGEST_TICK_MS`                 | `60000`                    | how often notification rules are checked (min 5000)                 |
| `TELEGRAM_API_BASE_URL`               | `https://api.telegram.org` | Bot API host (self-hosted server or proxy)                          |
| `CHAT_ALLOW_PRIVATE_URLS`             | `false`                    | allow a Time / Mattermost server on a private/loopback address      |
| `CHAT_SOCKET_SYNC_MS`                 | `15000`                    | how often open Time / Mattermost sockets are compared with the enabled bots |

The harvest's `HARVEST_*` (including the automatic harvest's `HARVEST_AUTO_*`) and `CHAT_LISTEN_TTL_DAYS` are in
[59](59-chat-harvest.md#operations).

## Data

All nine tables are new (`chat_captures` was folded into `knowledge_captures` by #82). None of them has an FK on `workspace_id`, `user_id` or
`created_by`, per house policy. The per-bot rows cascade with
`chat_integrations`.

| Table                   | Holds                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| `chat_integrations`     | bot: kind, name, server (Time, Mattermost; `''` otherwise), token envelope + hint, inbound secret hash, username, webhook / socket error, default agent, locale |
| `chat_channel_bindings` | group → project / agent / answer mode / locale / `listening` (#82)           |
| `chat_identities`       | messenger account → person, unique per bot                                    |
| `chat_link_codes`       | hashed one-time codes, with the private chat to confirm in                    |
| `chat_conversations`    | chat + asker → `assistant_threads` row                                        |
| `chat_answers`          | the claim: status, placeholder message id, platform thread (Time, Mattermost), assistant message id, frozen locale |
| `chat_buffered_messages` | masked messages a harvest may read: a listening group's, or a DM's forwards (#82; cascades with the bot and the binding) |
| `chat_harvest_marks`    | how far the automatic harvest has read each listening thread (#340; cascades with the binding) |
| `chat_subscriptions`    | a group's notification rule: project, folded tags, kinds, timing, cursor, next digest, last send / refusal (cascades with the binding) |

`chat_answers.assistantMessageId` is what 👍/👎 key on. Votes go into
`answer_feedback` under the `chat` surface (decided on #71), not into columns
of their own.

## Tests

- `test/chat-mattermost.spec.ts` (phase 4, #343; Mattermost-shaped fixtures,
  every case run once for `time` and once for `mattermost` by `describe.each`,
  plus one supervisor holding a bot of each kind):
  - `posted`: a channel mention is addressed and its own thread; a thread
    message belongs to the thread; a DM has none; `@knowledge-team` and an
    e-mail are not mentions; commands are whole words, addressed in a channel;
    the bot itself, other bots, system and empty posts are dropped.
  - Presses: a context signed with the token verifies and normalises; forged,
    re-targeted, another bot's, unsigned and a `posted` body pushed at the
    webhook are refused; a signed press is never read as a message too; the
    note comes back as `ephemeral_text`, `{}` without one.
  - Render: citations as links, page links resolved, `javascript:` dropped,
    mentions defused, code fences untouched.
  - Calls: a reply goes to the thread's root with signed buttons, a DM reply
    stays at the top, an edit always sends the buttons, errors keep the token
    out.
  - Supervisor: one authenticated socket per bot, `hello` clears the status, a
    `posted` event reaches `receive`, two replicas hand it on once, a dead
    claim store still answers, reconnect with backoff and the reason recorded,
    a silent socket is terminated, a bot turned off is closed for good and a
    new token reopens it.
- `test/chat-inbound.spec.ts` (threads): an unmentioned message in a thread the
  bot answered in is answered and its claim keeps the thread; a thread between
  people is left alone; a follow-up continues the asker's conversation; Time
  and Mattermost get the plain-word help, and a thread's `capture` and 📌
  harvest on both.

- `test/chat-subscriptions.spec.ts`:
  - Kinds read a page only on its default branch, first revision there as
    published; the inverse feeds SQL; tags fold like graph keys.
  - A second sweep with the same snapshot loses the claim; a restart resumes
    past the cursor, including a row stamped in the cursor's own instant; rows
    younger than the commit lag are left.
  - A tagged rule holds before a revision still indexing and gives up waiting
    after 10 minutes; a refused post puts the cursor back and records why.
  - Tags are asked of the graph in the rule's workspace; untagged and foreign
    pages are dropped; review branches are ignored, repeated edits fold, a
    merge is reported once.
  - Only a title and a link are rendered, escaped for Telegram; rows not
    reported still move the cursor; empty and full digest windows.

- `test/chat-capture.spec.ts`:
  - The transcript keeps only the turns shown in the chat, with citations as
    page links.
  - A page save is the assistant's answer capture with `client: 'chat'` and
    its origin, as the presser; a DM records no chat title.
  - A duplicate is said so without naming the page it matched; each capture
    refusal maps to its own reply.
  - A term is the first new suggestion, proposed into the inbox; none new is
    said so.

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
