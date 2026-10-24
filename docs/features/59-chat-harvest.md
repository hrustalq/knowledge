# 59 — Chat harvest: a Telegram, Time, Mattermost or Slack thread, proposed as reviewed captures

Issue [#82](https://github.com/hrustalq/knowledge/issues/82), shipped as five
PRs (#344–#347 and the one carrying this document). Before it, the only way
from a chat into the knowledge base was 💾 Save under a bot's own answer
([feature 47](47-chat-bots.md)). Save had its own path with no dedupe and no
inbox, and it could only keep what the bot said, never what the people in the
thread worked out.

Now a linked editor can ask the bot to **harvest** a thread. The platform
masks it, the `harvester` agent proposes what the thread settled, and the API
checks each proposal and writes the survivors as agent-memory captures
([feature 50](50-agent-memory.md)) in that person's name. They are reviewed
like any other capture. A harvest never indexes chat. A group's chat is
searchable only once an admin makes that group searchable, which is a
separate switch with its own store and retention ([feature 60](60-chat-search.md)).

## What

- **Ask for a harvest**, as a linked person with the `editor` role in the
  bound workspace:

  | trigger | Time, Mattermost, Slack | Telegram |
  | --- | --- | --- |
  | a command | `capture` (or `remember`, `запомни`) inside a thread, mentioning the bot in a channel | `/capture` as a reply to the first message of the thread |
  | a private chat | — | forward the bot the messages, then `/capture` |
  | a reaction | 📌 on any message of a thread | ✍ on a kept message, where the bot is a group admin |

  On **Teams** (#381) `capture` is said inside a channel thread, mentioning
  the bot, and reads that thread from the listening buffer: the root's id is
  the thread's topic, and its text is a kept row like the replies (Teams sends
  none of it with the command). A channel that does not keep its messages has
  nothing to read, and the bot says so (`chat.harvest.notKept`) rather than
  harvesting the command alone. Teams has no harvest reaction.

- **What it reads:**
  - **Time, Mattermost, Slack:** the whole thread, fetched by root. A command reads up to the
    command; a reaction reads all of it.
  - **Telegram group:** the replied-to message, then what the group (or
    forum topic) said from there up to the command, from the listening
    buffer.
  - **Telegram private chat:** exactly the messages forwarded within
    `HARVEST_FORWARD_WINDOW_SEC`.

  At most `HARVEST_MAX_MESSAGES`: the first message and the newest replies.
- **What it proposes:** decisions, gotchas, conventions, how-tos, glossary
  terms and answered questions, at most eight per harvest. Each becomes a
  capture with a server-set **origin**: platform, chat title, a link to the
  thread where the platform has one, and the time span of the messages.
- **What the chat sees:** counts and an inbox link ("Proposed 3 captures for
  review. 1 was already in the knowledge base and was skipped."), or "Nothing
  in this thread looked worth keeping." Never a title.
- **Keeping messages (Telegram).** A workspace admin can let a bound group
  keep its messages, masked, for `CHAT_LISTEN_TTL_DAYS` (*Keep messages for
  /capture* in Settings → Chat bots). `/forget` deletes a member's own.
- **💾 Save** on a bot answer moved onto the same capture path (phase 1).
- **Automatic harvest (#340).** A workspace admin can have a group that keeps
  its messages harvested without anyone asking: each thread once it has gone
  quiet, in the admin's name (*Harvest quiet threads automatically*). See
  [Automatic harvest](#automatic-harvest).

## The rules

### Who may ask, and when nobody is answered

`ChatAnswersService.harvest()` is the one entry for all three triggers. It
checks before reading anything:

1. **Linked?** An unlinked person gets the usual link-your-account reply.
2. **Editor?** `AccessService.principalFor` builds the person's principal
   outside a request, then `requireRole(…, 'editor')`. A viewer is told no.
3. **`HARVEST_ENABLED`?** Off, a command gets a notice.

A **reaction** is not addressed to the bot the way a command is. From anyone
but a linked editor it passes in silence: no reply, no read, no `ai_usage`
row. A refusal to a reaction would be the bot talking to people who were not
talking to it, and a busy channel's ordinary 📌 would get answers.

`HarvestService.harvest()` then refuses, each with a chat reply, when:

- the thread is empty;
- captures are switched off for the workspace (`captureSettings`);
- the person has started `HARVEST_RATE_PER_HOUR` harvests in the last hour,
  counted from their `harvest` AI usage rows, before any model call;
- the `harvester` agent is switched off;
- the workspace's AI budget would refuse the call (`assertWithinBudget`).

`CaptureService.capture` checks the editor role again before writing, and its
own capture rate limits still apply per proposal.

### Where a thread comes from

The adapter seam (`chat-adapter.types.ts`) has two optional members:

- `fetchThread(ctx, chatId, messageId, beforeMessageId, max)`: Time and
  Mattermost (one adapter, #343).
  `GET /posts/:id/thread` returns the whole thread from any post in it.
  Bots', system and empty posts are left out. `beforeMessageId` is the command;
  a reaction passes null. The thread link is the root's permalink, which needs
  the channel's team. A direct channel has no team, so no link, and a link that
  cannot be built is left out rather than failing the harvest.
- `fetchThread` on Slack (#380) is `conversations.replies` from the root:
  asked about a reply, Slack returns that reply alone with its `thread_ts`,
  so the thread is read again from the root (one page of 1000). Bots' and
  join/topic messages are left out, markup is read back to text, and the link
  is `chat.getPermalink` of the root, left out if it fails. 📌 is
  `reaction_added` with `pushpin`.
- `messageUrl(chatId, messageId)`: Telegram's `t.me/c/…` link for a
  supergroup. A basic group and a private chat have none.

Telegram has no thread to fetch, so `ChatBufferService` reads one instead:

- **Group** (`groupThread`): the replied-to message M as Telegram delivered
  it, then the buffer's rows for this chat and topic from M's time up to the
  command. With listening off it is M alone, and the reply says so. If M is
  older than what the buffer holds, the reply says the read is partial.
- **Private chat** (`forwards`): every forward within the window, oldest
  first, under its original author and time. A successful harvest consumes
  them, so the next `/capture` starts from nothing. The first forward of a
  batch gets one reply saying how to finish; the rest are kept quietly.

A Time or Mattermost command said at the top of a channel is its own thread, and the bot
says there is nothing above it to read.

### Reactions

Both adapters set `ChatInbound.harvestReaction` and leave `text` empty, because
neither platform says what the message was.

- **Time and Mattermost** watch `reaction_added` for `pushpin` on the websocket.
  `data.reaction` is a JSON string, as in Mattermost's `sendReactionEvent`. The
  supervisor claims `<bot>:<post>:pin:<user>`, apart from the post itself: the
  same person pinning again within the claim's hour is the same request.
- **Telegram** has no 📌: Bot API `ReactionTypeEmoji` allows a fixed list,
  and it is not on it. ✍ ("write this down") is. Pinning a message was
  rejected as the trigger, because it notifies the group and every rules pin
  would start a harvest. The webhook now asks for `message_reaction`, which
  Telegram delivers only where the bot is a group admin. Only a reaction just
  added counts, not one still there while another changes. An anonymous admin
  has no user to link and is ignored.

  The reaction carries no text, so `ChatBufferService.asReplyTo` turns it
  into the `/capture` that would have replied to M, from the kept row. A
  message the buffer does not hold (keeping off, M older than the buffer, or
  never seen) gets `chat.harvest.reactionNotKept`, and nothing is harvested.

### Masking

`harvest-mask.ts` is a regex masker, run before any model reads a thread:

| placeholder | matches |
| --- | --- |
| `[SECRET_n]` | the credential shapes `findSecret` knows (`SECRET_PATTERNS`), first, since a token can contain a card or phone shape |
| `[EMAIL_n]` | email addresses, case-folded for numbering |
| `[PASSPORT_n]` | a RU passport, series and number (4 + 6 digits): after `паспорт`, `серия` or `passport` (within 20 characters, no digit between) in any common spacing — `4509 123456`, `45 09 № 123456`, `4509 номер 123456`, `4509123456`; with no such word, only the printed `45 09 123456` form |
| `[SNILS_n]` | `112-233-445 95`, `112 233 445 95` or eleven bare digits that pass the SNILS checksum |
| `[INN_n]` | ten or twelve bare digits that pass the INN check digits (organisation or person) |
| `[CARD_n]` | 13–19 digits, spaces or dashes allowed, that pass Luhn |
| `[PHONE_n]` | three-three-two-two shapes with an optional `+code` or `8`, so a date or time never fits |

The table is the order the masker runs in. RU identity numbers come before
cards and phones because bare ten or eleven digits are also a phone shape,
and a checksum is the stronger claim: a phone number that happens to pass the
INN or SNILS check is masked as one, which still masks it. A passport has no
checksum, which is why it needs a context word unless it is written the way
the passport prints it; a bare `4509 123456` is as likely an order or a batch
number, and is left alone. Identity numbers are numbered by their digits, so
`112-233-445 95` and `11223344595` are one `[SNILS_n]`.

One masker numbers a value once, so the same address is the same placeholder
everywhere it is used:

- a Time thread is masked whole, so placeholders are stable across one harvest;
- a buffered Telegram row is masked on write with a fresh masker, so they are
  numbered per message. The raw text never reaches the database.

The masker keeps no value past the call. Authors become `Person 1`,
`Person 2` in order of first appearance: the model needs to tell speakers
apart, never who they are. There is no named-entity detection, and
`findSecret` stays the backstop on every capture.

### The harvester

A built-in agent (`built-in-agents.ts`): purpose `review`, `requires: ['json']`,
surfaces `background`, **no tools**. It can be switched off or tuned in
Settings → AI agents like any other.

Everything it may use is handed to it in one prompt:

- the masked thread, wrapped `wrapUntrusted(…, 'harvest', 'chat')`;
- the pages an answer may cite. `pagesFor` runs one hybrid search over the
  first 2 000 characters of the masked thread **under the asker's own
  scope**, and labels up to eight distinct pages `P1…P8` (title and a
  300-character snippet), wrapped untrusted. The model sees labels, never ids.

Its instructions forbid stating anything the thread does not say, allow an
empty list as a good answer, and say placeholders stay as they are. The
caller appends the cap (eight), which it owns as `MAX_PROPOSALS`.

### Validation happens here, not in the prompt

`planCaptures` turns the model's JSON into capture requests and drops, and
counts, anything that is not grounded:

- an unknown kind, a missing field, or anything past the eighth;
- a **glossary** term that does not appear word for word in the masked thread
  (`countOccurrences`, the glossary's own matcher). An alias that does not
  appear is dropped from the term;
- an **answer** whose `pages` name no label the search handed out. A label
  the turn did not issue cites nothing, so an answer with no search (search
  failed, nothing found) is always dropped.

Each survivor goes to `CaptureService.capture(req, principal, { origin })`.
A proposal the capture path refuses (a credential shape, too long, the
capture rate, a page gone since the search) counts as dropped. It is one
proposal, not the harvest. A `duplicate` result counts as a duplicate.

### Origin is the server's

`CaptureOrigin` (`@knowledge/contracts`) is `{ platform, chatTitle, threadUrl?,
from, to }`, built from the chat delivery. No request DTO accepts it, and the
model never sees it, so unlike `CaptureSession` it is a fact rather than a
report. `CaptureSession.client` gained `'chat'`.

The origin is shown:

- in the Captures inbox row (`CaptureOriginParts.vue`);
- in the merge request description (`capture.mergeRequest.introChat`) and its
  provenance strip (`MrProvenance.vue`);
- in a new or amended page's frontmatter, appended under `sources:`
  (`withOriginSource`).

### The reply carries counts only

The placeholder ("Reading the thread for what it settled…") is replaced by `harvestSummary`: how
many were proposed, how many were duplicates, a note when the thread was cut
to the cap, and the buffer's note on a partial read. The inbox button appears
only when something was proposed or matched. It never names a capture or a
matched page, because the group may include people who cannot open them.
`dropped` is never mentioned in the chat.

### Spend

Each harvest is one model call, booked as `AiUsageOperation 'harvest'`
against the asker. The rate limit counts those rows, so the limit and the bill
cannot disagree.

### The listening buffer

`chat_buffered_messages` holds masked text only, keyed by bot, binding, chat,
topic and message (unique per chat and message, so a redelivery is a no-op).
A DM forward has no binding.

- **Turning it on** (`PATCH /v1/chat/bindings/:id { listening: true }`,
  workspace admin, Telegram only) posts the notice in the group first. If the
  bot cannot post it, the switch fails and nothing is kept, because a group
  that was never told is a group being recorded.
- **Kept:** people's messages that are not commands, while
  `HARVEST_ENABLED` is on. Commands and the bot's own messages are not kept.
  The group is still answered as usual.
- **Never read** by search, the assistant, MCP or ingestion. A harvest is the
  only reader, and a spec asserts no other code touches the table.
- **Dropped:**
  - on the chat-answer sweeper's one-minute tick, past `CHAT_LISTEN_TTL_DAYS`
    for a group and past `HARVEST_FORWARD_WINDOW_SEC` for a DM's forwards;
  - at once when listening is turned off;
  - with the binding (FK cascade) when the group is unbound, and with the bot;
  - per author on `/forget`, which needs no link and no role. In a private
    chat it also drops that person's forwards.

Keeping needs the bot to see group messages: privacy mode off in @BotFather,
or the bot made a group admin. ✍ needs admin either way.

### Automatic harvest

A request for a harvest is explicit everywhere above. #340 adds the one
exception: a listening Telegram group whose threads are harvested by a
sweeper, because a thread that settles something and that nobody marks is
otherwise lost.

**The switch.** `PATCH /v1/chat/bindings/:id { autoHarvest: true }`, workspace
admin, on a binding that keeps its messages (400 otherwise). Like turning
listening on, the bot first tells the group (`chat.listen.autoOn`), and if it
cannot, nothing is switched. Turning listening off turns this off too.

**Who it runs as.** The admin who turned it on: `chat_channel_bindings.auto_harvest_by`,
set from the request's principal and never from the body — the
[agent-trigger owner rule](49-agent-triggers.md#identity). Another admin
pressing it again does not take it over; off and on again does. On every
harvest the sweeper builds that person's principal (`principalFor`) and
requires `admin` again, so a demoted, removed or disabled admin's switch
harvests nothing. The harvest is the ordinary `HarvestService.harvest` as
that person: their scope for the pages an answer may cite, their name on the
captures, their `HARVEST_RATE_PER_HOUR`, the workspace budget.

**What a thread is.** Telegram has no threads, so one listening thread is a
group, or one forum topic of it (`chat_harvest_marks.topic_key`, `''` outside
a topic). The sweeper reads what was kept after both the switch
(`auto_harvest_at`) and the thread's mark: nothing said before an admin turned
it on is read automatically.

**When one is due.** `isThreadDue` (`chat-auto-harvest.sweeper.ts`) is the one
predicate: at least `HARVEST_AUTO_MIN_MESSAGES` new kept messages, and none
for `HARVEST_AUTO_QUIET_MINUTES`. `ChatBufferService.listenedThreads`
returns only threads with something new since the mark, so a thread is
harvested again only after its content changed. `created_at`, the server's
clock, is the measure throughout, never Telegram's `sent_at`.

**Once, on whichever API process.** `ChatAutoHarvestSweeper` is API-side, a
60-second tick, never a second sweep while one runs, and on only while
`CHAT_ENABLED`, `HARVEST_ENABLED` and `HARVEST_AUTO_ENABLED` are. Every API
process runs it. Before the model is called, the thread's mark is moved to
the newest message the sweep saw by one guarded statement (an insert on the
unique key, or an update from the value it read), and only the process that
moved it harvests. A refusal that will pass (the hourly rate, the AI budget)
puts the mark back for the next tick. Any other outcome leaves it: a model
failure or a switched-off `harvester` is not retried until something new is
said.

**Spend.** One harvest is one model call, booked as `AiUsageOperation 'harvest'`
against the admin. At most `HARVEST_AUTO_MAX_PER_TICK` threads per binding
per tick, the longest quiet first; the rest stay due for the next tick.

**Nothing is posted in the group.** The manual paths reply where they were
asked, because someone asked. Here nobody did, and a bot that speaks after
every quiet hour is the bot talking to people who were not talking to it —
the reason a stranger's reaction gets no reply. The group was told once, when
the switch went on. The admin the captures are attributed to gets an inbox
row instead (`chat.harvest.proposed`, category `job`, linking to
`/captures`), only when something was proposed, carrying the group's name
and the counts. Never a capture's title; the Captures inbox shows those under
its own rules. A bot DM was rejected: the admin need not have linked an
account, and the inbox is the per-person surface that already exists.

### Save is a capture too

Phase 1 moved 💾 Save onto `CaptureService`
([feature 47](47-chat-bots.md#saving-a-conversation)):

- *As a page draft* is an `answer` capture citing the pages the answer cited,
  the same as the assistant pane's "Save to knowledge base". An answer that
  cites no page can no longer be saved.
- *As a glossary term* is a `glossary` capture in the inbox.

Both carry an origin. `chat_captures` rows were copied into
`knowledge_captures` with their status and the table was dropped, so there is
one save path, one dedupe and one inbox.

## Decisions

- **A harvest never indexes chat.** Searching chat shipped later as its own
  per-group switch, store and retention ([feature 60](60-chat-search.md), #339).
  It never reads the listening buffer, and turning one on never turns on the
  other.
- **Proposals go through agent memory.** No new `ConnectorRunItem` kinds and
  no capture runs; feature-26 run items stay pages-only.
- **Sources were the existing chat-bot platforms** at first. Trackers and help
  desks came later as harvest connectors (see Trackers and help desks).
- **Triggers are explicit:** a command, a forward or a reaction. The one
  exception is the automatic harvest (#340): opt-in per group, by an admin,
  told to the group, and in that admin's name.
- **An automatic harvest posts nothing in the group** and tells the admin it
  ran as, in the app's inbox (#340).
- **Telegram threads come from an opt-in, admin-enabled buffer** with a short
  TTL, masked on write. Telegram's privacy mode means a bot otherwise sees
  only what is addressed to it.
- **Attribution goes to the person who asked**: the feature-47 rule, the
  linked person, never a bot principal.
- **The harvest runs API-side**, in the webhook's or socket's continuation,
  because a capture is attributed to a person and the API is where a
  principal exists.
- **Telegram uses ✍, not 📌**, and not pinning (see Reactions).
- **Only a linked editor's reaction does anything.**
- **An answer must cite a page** found under the asker's scope, or it is
  dropped.
- **Masking is regex and checksums only.** A passport, which has no checksum,
  needs a context word or the printed `45 09 123456` form (#342).
- **The chat reply carries counts and a link only.**
- **Decisions live here**, not in ADRs.

## Surface

### Chat

| | Time, Mattermost | Telegram |
| --- | --- | --- |
| harvest | `capture` / `remember` / `запомни` in a thread; 📌 | `/capture` as a reply, or after forwards in a DM; ✍ |
| forget | — | `/forget` |
| help | `help` lists `capture` and 📌 | `/help` lists `/capture`, ✍ and `/forget` |

### REST

| route | role | |
| --- | --- | --- |
| `GET /v1/chat/integrations/:id/bindings` | admin | now `{ bindings, listenTtlDays }`; each binding has `listening` |
| `PATCH /v1/chat/bindings/:id` | admin | `listening` joins the body; Telegram only, 400 otherwise or when the notice fails. `autoHarvest` (#340): needs listening, notice first, the caller becomes `autoHarvestBy` |

The bindings list also carries `autoHarvest: { available, minMessages,
quietMinutes }`, the server's ceiling and thresholds, and each binding
`autoHarvestBy` / `autoHarvestAt`.

Captures are read and decided through the existing `/v1/captures` routes;
`CaptureInfo` has `origin`.

### Web

- `chat-bots/ChatBindingTable.vue`: the *Keep messages for /capture* switch on
  a Telegram group. It waits on the API, since turning it on waits on the
  group notice. The setup hint says ✍ needs the bot to be an admin.
  Under it, *Harvest quiet threads automatically* (#340), with the thresholds
  in its hint, who it runs as (`UserChip`), and a warning when the server's
  ceiling has it off whatever the switch says.
- The inbox row for an automatic harvest opens `/captures`
  (`notification-ui.ts`).
- `captures/CaptureOriginParts.vue`: the origin in `CaptureRow.vue` and
  `MrProvenance.vue`.

## Operations

- Migrations:
  - `20261117100000_chat_captures_into_agent_memory` adds
    `knowledge_captures.origin`, copies `chat_captures` across and **drops
    it**. Not reversible under expand/contract: after a rollback to v0.27.x,
    💾 Save fails until this release is rolled forward again.
  - `20261118100000_chat_listening_buffer` adds
    `chat_channel_bindings.listening` and `chat_buffered_messages`. Additive.
    After a final rollback, drop the table by hand.
  - `20261120100000_chat_auto_harvest` (#340) adds the nullable
    `chat_channel_bindings.auto_harvest_by` / `auto_harvest_at` and
    `chat_harvest_marks`. Additive. After a final rollback, drop them by hand.
- Env vars, all with defaults:

  | var | default | |
  | --- | --- | --- |
  | `HARVEST_ENABLED` | `true` | `false`: commands get a notice, reactions nothing, nothing is kept |
  | `HARVEST_MAX_MESSAGES` | `200` | the first message and the newest replies |
  | `HARVEST_RATE_PER_HOUR` | `10` | per person, from `harvest` usage rows |
  | `HARVEST_FORWARD_WINDOW_SEC` | `120` | a DM's forwards that make the thread |
  | `CHAT_LISTEN_TTL_DAYS` | `7` | how long a listening group's messages are kept |
  | `HARVEST_AUTO_ENABLED` | `true` | the ceiling over every group's automatic-harvest switch |
  | `HARVEST_AUTO_MIN_MESSAGES` | `8` | new kept messages a thread needs to be due |
  | `HARVEST_AUTO_QUIET_MINUTES` | `60` | minutes without a new message before it is due |
  | `HARVEST_AUTO_MAX_PER_TICK` | `1` | automatic harvests per group per minute; `0` stops the sweeper |

  `CHAT_CAPTURE_TIMEOUT_SECONDS` is no longer read.
- **Telegram bots need their webhook registered again** to receive ✍: press
  **Test** on each bot in Settings → Chat bots after deploying.
- Production cannot reach `api.telegram.org` until `TELEGRAM_API_BASE_URL`
  points at a proxy, so Time or Mattermost is the first platform that can be
  checked there.

## Trackers and help desks (#382–#384)

A resolved Linear issue, a solved Zendesk ticket or a closed Intercom
conversation can be harvested the way a chat thread is. A tracker or a help
desk is not a chat, though. Nobody is talking to a bot, there is no group to
bind, and the item usually ends with somebody resolving it. These decisions
were settled with the owner on 2026-10-22, before any code:

- **It is a connector, not a chat platform.** Each source is a connector kind
  (`linear`, `zendesk`, `intercom`) with `capabilities.harvest`, and moves no
  content (`pull: false, push: false`), so it has no Sync button, no
  destination and no runs.
  - The credential goes in the connector credential box.
  - The source signs its webhook with a secret it generates itself (Linear's
    webhook signing secret, Zendesk's webhook signing secret, the Intercom
    app's client secret). The admin pastes it as the connector's webhook
    secret.
  - Deliveries reach the existing `/v1/connectors/:id/webhook`.
  - People are matched through the connector's `external_identities`.
- **What starts a harvest: resolution while labelled.** The item must reach
  its resolved state while it carries the connector's harvest label or tag
  (`config.harvestLabel`, default `knowledge`, matched case-insensitively).
  Nothing is harvested by default, and the spend stays with items somebody
  marked as worth keeping.

  | source   | resolved means                                  | label is      | delivery                                   |
  | -------- | ----------------------------------------------- | ------------- | ------------------------------------------ |
  | Linear   | the issue moved into a `completed`-type state   | an issue label | `Issue` `update` webhook, `Linear-Signature` (hex HMAC-SHA256 of the body), `webhookTimestamp` ≤ 60 s old |
  | Zendesk  | status became `solved`                          | a ticket tag   | a trigger-driven webhook with a fixed JSON body, `X-Zendesk-Webhook-Signature` (base64 HMAC-SHA256 of timestamp + body) |
  | Intercom | the conversation was closed by an admin         | a conversation tag | `conversation.admin.closed` topic, `X-Hub-Signature: sha1=` HMAC of the body with the app's client secret |

- **It runs as the person who resolved it, or not at all.** That person is the
  delivery's actor: Linear's `actor`, the Zendesk updater the trigger names,
  the Intercom admin who closed the conversation. They are recorded in
  `external_identities`, and the existing resolver maps them to a member (an
  admin's manual mapping first, then a verified email). The person must hold
  `editor` in the workspace now. Anyone else, unmapped or without the role, gets
  nothing, and nothing is answered or posted anywhere. There is no bot
  principal: the feature-47 rule.
- **What is read.** The item is fetched fresh from the source, never taken from
  the delivery: Linear's description and comments, a Zendesk ticket's comments
  (**public replies and internal notes**), an Intercom conversation's opening
  message, replies and admin notes. The fetch also re-checks resolution and the
  label. Every message is masked by `harvest-mask.ts` before the model reads
  it, and the thread is wrapped untrusted, as in chat.
  - Customer messages carry PII, which is why masking comes first.
  - Notes usually hold the actual fix, which is why they are read.
  - Authors are the source's opaque ids, numbered in the transcript as in chat.
- **Once per item, through a guarded row, finished by a sweeper.** The webhook
  only verifies and claims: one `connector_harvests` row per (connector,
  item), inserted only if absent. An API-side sweeper takes the claimed rows,
  checks the person, reads the item and calls `HarvestService.harvest` as that
  person. This is "the handler does no work beyond verifying and enqueueing"
  (doc 19), and the row doubles as crash recovery.
  - A row whose item turns out not to qualify (no longer resolved or labelled,
    an unmapped person) is deleted, so a later qualifying delivery can claim
    the item again.
  - A harvested item is never harvested twice.
- **Where it lives (#382, shipped for Linear first).**
  - `ConnectorAdapter` gains two optional members:
    `verifyHarvestDelivery(ctx, headers, rawBody)` → `{ item }` or null
    (401), and `readHarvestItem(ctx, id)` → the item fresh, or null.
  - `ConnectorWebhookController` hands a verified resolution to
    `ConnectorHarvestSweeper.claim`. The claim records the person through
    `ConnectorAclService.userFor` (the delivery is the only place their
    email is) and inserts the row.
  - `ConnectorHarvestSweeper` is in `ConnectorsModule`, API-only. It takes up
    to five unharvested rows every 30 s under a 10-minute lease and finishes
    each.
  - `HarvestService` moved into `HarvestCoreModule`, so ChatModule and
    ConnectorsModule share it without loading each other's controllers.
  - It is off with `HARVEST_ENABLED=false`, like every harvest.
  - Linear specifically:
    - The webhook is on **Issues**.
    - `Linear-Signature` must match, and `webhookTimestamp` must be within
      60 s.
    - The prefilter is an `Issue` `update` with `stateId` in `updatedFrom`, by
      a `user` actor.
    - The read is one GraphQL call: identifier, title, URL, `state.type`,
      labels, the description and up to 250 comments.
    - The key goes bare in `Authorization`.
- **Zendesk (#383).**
  - Zendesk has no "ticket solved" subscription of its own, so the admin
    builds a trigger: *Ticket status changed to Solved*, *Tags contain* the
    harvest tag, and a *Notify webhook* action whose JSON body is
    `ZENDESK_TRIGGER_BODY` (contracts: ticket id, status, and the updating
    agent's id, name and email). The dialog shows it to paste.
  - The signature is `X-Zendesk-Webhook-Signature`, base64 HMAC-SHA256 over
    the `-Timestamp` header plus the raw body. A timestamp more than 5 minutes
    off is refused.
  - The prefilter: status `solved` or `closed`, and a numeric agent id
    (`-1`, Zendesk itself, is no person).
  - The read is the ticket (subject, status, tags) and one page of 100
    comments, oldest first, public and private alike, as `email/token`
    Basic auth. A 404 or 403 is a ticket gone.
  - `testConnection` refuses an end-user credential, which cannot read
    tickets.
- **Intercom (#384).**
  - The admin's Intercom app subscribes its webhook to
    `conversation.admin.closed`. The app's **client secret** is the webhook
    secret, and its access token is the credential. A region select (US, EU,
    AU) picks the API host.
  - The signature is `X-Hub-Signature: sha1=` hex HMAC-SHA1 of the raw body.
    Intercom signs no timestamp, so there is no replay window, and none is
    needed: the claim is once per conversation, and the sweeper re-reads the
    conversation before anything is harvested.
  - Who closed it is the author of the conversation's last `close` part, and
    it must be an `admin`. Bots and Fin are no person.
  - The read is `GET /conversations/:id` (`Intercom-Version: 2.11`): the
    opening message, every `comment` and `note` part (replies **and** admin
    notes), with bot parts dropped. HTML is read back to text. The URL needs
    the app's `id_code`, so `/me` is read once per harvest. A 404 or 403
    means the conversation is gone.
- **The same contract as chat.** Captures go through `CaptureService` with a
  server-set origin (`platform: 'linear' | 'zendesk' | 'intercom'`, the
  item's key and title, its URL, the span of its messages). They are
  reviewed in the Captures inbox. Nothing is indexed, nothing is synced back,
  and the spend is one `harvest` AI usage row. Nothing is written on the
  ticket: the person who resolved it gets one inbox notification with the
  counts, as the automatic harvest's admin does.

## Deliberate deferrals

- No new sources (Teams and the rest #341, Google Drive #338). Slack shipped
  as a chat platform (#380); Linear, Zendesk and Intercom as harvest
  connectors (#382–#384, above).
- A harvest connector reads one page of an item's comments (Linear 250,
  Zendesk 100, Intercom's 500-part cap); longer items are harvested from what
  that page holds (`ponytail:` markers in each adapter). Chat
  search arrived separately as [feature 60](60-chat-search.md).
- No named-entity detection, no reversible masking. A passport mentioned with
  its context word more than 20 characters (or a digit) away from the number
  is not masked.
- A manual harvest runs in the delivery's continuation, with no sweeper of its own.
  A deploy mid-harvest leaves the reading placeholder in the chat; the
  proposals already written stand.
- The automatic harvest's thresholds are server-wide env, not per group, and
  were set before there was precision data from manual harvests. A deploy
  mid-harvest leaves the thread marked: it is harvested again once something
  new is said in it.
- Automatic harvest is Telegram only, since only Telegram groups keep
  messages. Time threads would need their own record of which threads exist.
- The forward window is per chat, not per batch: two quick batches in one
  private chat are one thread.

## Verification

- Unit (`apps/api/test/`):
  - `chat-harvest.spec.ts`: the masker (each kind, stable numbering, dates
    and non-Luhn numbers left alone, local phone shapes; INN and SNILS
    checksums, passport forms with and without context, order ids, dates, a
    bare 4 + 6 number and 10/12 digits failing the checksum left alone, phones
    and cards not read as identity numbers); `planCaptures`
    dropping an ungrounded term or an uncited answer; `HarvestService` with a
    capturing fake model (the prompt holds no fixture value, captures are
    written as the asker with the server origin, the rate limit is refused
    before any model call); the reply is counts only, never a title.
  - `chat-buffer.spec.ts`: masking on write, the three reads, truncation,
    TTL and window, `/forget`, the listening switch (notice first, nothing
    kept when it fails, purge on off, Time refused), ✍ as a reply, and that
    no search, assistant or MCP code reads the table.
  - `chat-inbound.spec.ts`: the triggers end to end through
    `ChatAnswersService`: linked editor, unlinked, viewer, top of a channel,
    group and DM `/capture`, forwards, `/forget`, 📌 and ✍, and silence for
    anyone else's reaction.
  - `chat-mattermost.spec.ts` (run for `time` and `mattermost`),
    `chat-telegram.spec.ts`: parsing the commands, a reaction and the thread
    fetch against fixture shapes.
  - `chat-capture.spec.ts`, `capture-templates.spec.ts`: Save as a capture,
    and the origin in the description and in `sources:`.
  - `chat-auto-harvest.spec.ts` (#340): the due predicate, the per-binding
    spend cap, no second sweep while one runs, the mark moved before the
    model (a losing process harvests nothing), reading only past the mark and
    the switch, putting the mark back on the rate limit or budget only,
    attribution to the enabling admin re-checked as admin, nothing posted in
    the group and an inbox row with counts; the switch (notice first, needs
    listening, never taken over, cleared with listening).
- The automatic harvest's SQL (`listenedThreads`) was run against a scratch
  database with every migration applied: messages before the switch and a
  binding not opted in are left out, and a mark at the rounded-up newest
  `created_at` leaves nothing of that thread.
- **Live Mattermost, once (#343).** Against a `mattermost/mattermost-preview`
  container: the bot's token identified, its websocket greeted, a channel
  mention, `help`, a DM `new`, the reply in the question's thread, a signed
  button press answered with `ephemeral_text`, an edit clearing the buttons,
  📌 handed on and ✅ ignored, `@knowledge capture` in the thread, and
  `fetchThread` reading people's posts with the team permalink, from the root
  and from a reply. Telegram parsing is still pinned only to the Bot API
  documentation, and **no live Time server has been tried**.
