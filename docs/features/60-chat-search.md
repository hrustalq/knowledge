# 60 — Chat search: what was said in a bound group, masked, under the project's audience

Issue [#339](https://github.com/hrustalq/knowledge/issues/339), shipped as six
PRs (#396–#399, #404 and the one carrying this document). Before it, chat was
harvested into reviewed captures ([feature 59](59-chat-harvest.md)) and never
indexed, so "what did we decide about the billing retry in #payments last
month?" had no answer. The only chat the platform kept was Telegram's
listening buffer, which is harvest-only and held for 7 days.

Now a workspace admin can make a bound group **searchable**. From then on its
people's messages are masked, kept for a retention period, packed into thread
windows, embedded and searchable. That covers Telegram groups, Time channels
and Mattermost channels ([feature 47](47-chat-bots.md)). People search them
from a **Chat** tab on `/search`, agents through `knowledge_search_chat` and
`search_chat`, and a bot answering in a group can cite them. Chat results are
never mixed into page results.

## What

- **Make searchable** is a per-binding switch in Settings → Chat bots, on all
  three platforms. It is independent of *Keep messages for /capture*: turning
  one on never turns on the other.
- **Before anything is kept** the bot posts a notice in the group. It names
  the retention period and says `/forget` still works. If the post fails,
  nothing is switched on.
- **Kept:** every person's non-command message in the group, masked before it
  is written. Edits are followed everywhere. Deletes are followed on Time and
  Mattermost; Telegram never tells bots about deletions.
- **Searched:** windows of one thread at a time. Search ranks the meaning and
  the words together, and returns only groups the caller may read.
- **Gone:** past the retention, on switch-off, on unbind, and on `/forget` for
  the asker's own messages. In every case the messages leave Postgres and
  ArcadeDB both.

## The rules

### A store of its own

`chat_messages` and `chat_chunks` are separate from pages and from the
harvest buffer (`chat_buffered_messages`). The buffer keeps its single reader,
its 7-day TTL and its guard spec (`test/chat-buffer.spec.ts`), which is
unchanged. Searchable chat has its own switch, retention and consent, so the
two never share a row. All writes go through `ChatMessagesService`.

- **`chat_messages`** — one row per kept message: `threadKey`
  (the Time/Mattermost root post, the Telegram forum topic, or `''`),
  `externalMessageId`, the platform's opaque `authorId` (what `/forget`
  matches), masked `text`, `sentAt`, `editedAt`, and `chunkId` (null until
  packed). A redelivery is a no-op (`@@unique([bindingId, externalMessageId])`).
- **`chat_chunks`** — one row per window: masked text as
  `author-n: line` per message, `firstAt`/`lastAt`, `messageCount`, and a
  generated `search_tsv` (`to_tsvector('russian', text)`, GIN-indexed).
- **ArcadeDB** — one `ChatChunk` vertex per chunk,
  `{ chunkId, workspaceId, bindingId, embedding }`, with its own
  `LSM_VECTOR` index (`ChatChunk[embedding]`). `ensureVectorIndex`,
  `vectorIndexFits` and the neighbour query are parameterised by vertex type
  rather than copied.

**Postgres is the truth.** A vector whose row is gone is never served,
because search joins the row. The indexer reaps such orphans every ten ticks.

### Masked on write

`ChatMessagesService.keep` runs a fresh `createMasker()`
(`chat/harvest-mask.ts`) over every message before the insert, as the harvest
buffer does. That masks secrets, email, RU passport, SNILS, INN, Luhn-checked
cards and phones with numbered placeholders. An edit is masked again.

**A window names no one.** `windowText` labels authors `author-1`,
`author-2`… in order of first appearance within the chunk. No name or
platform id reaches a chunk, a vector or a prompt.

### The switch

`PATCH /v1/chat/bindings/:id { searchable }` (admin):

- **On:** refused while `CHAT_SEARCH_ENABLED` is off. Otherwise
  `tellGroup('chat.search.on', { count: appliedDays })` must succeed first,
  then `searchableBy` and `searchableAt` are set to the caller and now. Who
  turned it on is whoever made the call, never a body field.
- **Off:** `purgeBinding` deletes the binding's chunks and messages at once,
  not at the retention, and then clears both columns.
- **Unbind:** the FK cascade removes the rows; the next reap removes the
  vectors.

### Retention: the env is a ceiling

`CHAT_SEARCH_RETENTION_DAYS` (90) is a ceiling.
`workspace_settings.chat_search_retention_days` may only shorten it: `null`
inherits, and a longer value is saved as asked and applied clamped.
`GET /v1/chat/search-settings` returns `{ ceiling, requested, applied }`, and
the settings page shows all three, so the clamp is never silent.

`purgeExpired` runs API-side on `ChatAnswerSweeper`'s 60-second tick, beside
the buffer's own sweep. It deletes a **chunk whole** once its newest message
is past the cutoff, and a message only once it is past and in no chunk. So a
window is never served half-expired. The vectors of deleted chunks go at the
indexer's next reap.

### The indexer

`ChatIndexSweeper` is worker-only: a fixed tick (`CHAT_SEARCH_TICK_SEC`) with
back-pressure, and no cron. Each tick packs the threads of searchable groups
whose messages are ready (`sealedWindows` in `chat/chat-windows.ts`):

- A window is split at a silence of `CHAT_SEARCH_WINDOW_GAP_MIN` and at
  `CHAT_SEARCH_WINDOW_MESSAGES` messages.
- Every window but the last is ready. The last is ready once full, or once
  the thread has been quiet for `CHAT_SEARCH_SETTLE_MIN`, so a live thread is
  not re-embedded on every message.
- A pack writes the vector first, then the row, in a transaction that locks
  the window's messages and checks they are still unpacked and unchanged. An
  edit or `/forget` that got there first makes the pack give up, and it reads
  the window again next tick.
- At most 50 threads per tick, one embedding call each, so a backlog drains
  over several ticks.

**Changing a message** (an edit, a delete, `/forget`) deletes the chunk that
held it. `ON DELETE SET NULL` detaches its sibling messages, and the next
tick packs them again. So a message becomes searchable within
`CHAT_SEARCH_SETTLE_MIN` plus one tick of its thread going quiet.

The cost is embeddings only. There is no model call, and no new
`AiUsageOperation`.

### Who can read a group's chat

A group's chat is visible to whoever can see the **binding's project** under
the [feature 48](48-page-permissions.md) `AccessScope`. One predicate decides
it, `canSeeChat` in `permissions/access-scope.ts`:

- **Bound to a project:** `canSee` with an empty page path. A restricted
  project hides it from anyone without a grant there, and a guest reaches it
  only through a grant on the project.
- **Bound to no project:** it speaks for the whole workspace, so it is
  visible to members and never to guests.

`canSeeChat` is read in memory over the workspace's few searchable bindings,
so it has no SQL spelling to keep in step with the other three.

**The ACL runs before retrieval.** `ChatSearchService.readableBindings`
decides the readable bindings in Postgres, and an empty set returns before
anything is embedded. Both legs are restricted to those binding ids, and the
final read joins `chat_chunks` on them again. Filters (`projectIds`,
`bindingIds`, `from`/`to`) only narrow that set. Asking for a hidden binding
by id returns nothing.

Making a group searchable is the admin asserting that this audience is fine,
just as binding the group asserted it for answers (feature 47).

### Ranking

There are two legs, fused with the page search's own `fuseHits` (RRF, k = 60)
over a 4× over-fetch:

- **vector:** `nearestChatChunks` over `ChatChunk[embedding]`, pre-filtered
  to `workspaceId` and the readable `bindingId`s;
- **text:** `plainto_tsquery('russian', …)` over `chat_chunks.search_tsv`, on
  the same bindings.

The text leg is Postgres, not the optional fulltext provider, so chat search
works with `FULLTEXT_PROVIDER=none`, the default. It uses the `russian`
config: chat here is mostly Russian, and English words still match as
unstemmed lexemes.

A hit is `{ chunkId, bindingId, chatTitle, platform, projectId, firstAt,
lastAt, messageCount, snippet, url }`. The snippet is cut at 400 characters
after filtering. `url` links the window's first message where the platform
has links: Telegram supergroups, through `t.me/c/…`.

### Agents and bots

- **`knowledge_search_chat`** (MCP) starts with `guard.pages(workspaceId)`,
  the twin of the REST route's `@Access('viewer', 'body', { guests: true })`.
  It is not in `WRITE_TOOLS`, so it is `readOnlyHint: true` and a read-only
  key gets it.
- **`search_chat`** (the assistant) runs under `scopeOf(ctx)`, asked afresh
  on every call, so a bot turn is clamped by `PermissionService.audienceScope`.
  With `ctx.projectId` (a bound group) it pins `projectIds`, as
  `search_knowledge` does.
  - **Offered** only by `definitions({ chat: true })`. A turn passes that
    while the workspace has a searchable group (one indexed count per turn).
  - **Named** by the researcher and the author only. A background agent's
    findings become proposals, and a proposal resting on an unreviewed
    message is the wrong default. An admin can still add it to a custom agent.
- **Both are wrapped untrusted** with origin `conversation`. The existing
  `chat` origin describes a bot conversation saved as a page, which is a
  different thing.
- **A chat window is its own citation kind.** `AssistantChatSource`
  (`kind: 'chat'`) joins the source union, keyed `chat:<chunkId>`.
  `finalizeCitations` keeps a `[S#]` the turn handed out for it, as for a page
  or a web page. Page-only readers (provenance, answer feedback, the capture
  inbox, confidence signals, the web chip) test `isPageSource` from
  contracts, never `!isWebSource`: with a third kind, that spelling would have
  let a chat window through as a page.

**The audience risk from feature 47 applies unchanged.** A bot answer is
shown to everyone in the group, so a group bound to a project can be shown
that project's chat by an answer. The clamp keeps a restricted project's chat
out of a group whose audience could not read it. It does not make the group's
members workspace members.

## Decisions

- **Sources are the chats the bots already see**, through
  `chat_channel_bindings`. There are no new connector kinds. Slack and Teams
  (#380, #381) inherit this.
- **Opt-in per binding, by an admin, notice first.** This is the listening
  switch's precedent (`ChatIntegrationsService.switchListening`).
- **Masked on write, ceiling retention, immediate purges.** Off, unbind and
  `/forget` do not wait for the retention.
- **Separate from pages everywhere.** It has its own tables, its own vector
  index, its own REST route, its own tools and its own tab. Page search, its
  ranking and its results are untouched.
- **Postgres full text, not a second OpenSearch index.** This departs from
  #82's sketch, because the fulltext provider is optional and has no PG
  implementation. A second OpenSearch index can follow if PG ranking proves
  weak.
- **The ACL is one in-memory predicate** (`canSeeChat`), not a new SQL
  spelling. The issue planned `canSeeProject`/`projectVisibilitySql`. The set
  is a workspace's handful of bindings, so a SQL twin would be a fourth
  spelling to keep in step for no gain.
- **No backfill.** Only messages sent after the switch are kept. Telegram
  cannot fetch history, and a Time/Mattermost backfill is a follow-up if
  asked for.

## Surface

### Chat

- The `chat.search.on` notice names the applied retention and `/forget`.
- `/forget` deletes the asker's searchable messages in every group of that
  bot, along with every chunk that held one. Its reply counts them with the
  buffered ones.
- The `chat.listen.on` notice already said "Nothing kept for /capture is
  searchable", which is still true.

### REST

| Route | Access | What |
| --- | --- | --- |
| `PATCH /v1/chat/bindings/:id` `{ searchable }` | admin | the switch; 400 if the notice fails or `CHAT_SEARCH_ENABLED` is off |
| `GET /v1/chat/integrations/:id/bindings` | admin | each binding's `searchableBy`/`searchableAt`, plus `search: ChatSearchSettings` |
| `GET` / `PATCH /v1/chat/search-settings` | admin | retention: ceiling, requested, applied |
| `POST /v1/chat/search` | viewer, guests | the search |
| `GET /v1/chat/search?workspaceId=` | viewer, guests | `{ readable }`: whether the caller may read any searchable group (the same ACL, no query) |

### MCP

`knowledge_search_chat { workspaceId, query, projectIds?, bindingIds?, from?,
to?, limit? }` is read-only. `skill.ts` says when to use it and how to cite a
chat window.

### Web

- **`/search`** has a **Pages | Chat** strip (`PageTabs`; `?tab=chat` is an
  opening instruction). The Chat tab appears only when `GET /v1/chat/search`
  says `readable`.
  - The tab is `ChatSearchWidget` over the shared `SearchPanel`, fed by a chat
    `SearchSource` (`chat-search-source.ts`).
  - A row shows the group, platform, time span (`formatDateTimeRange`),
    message count and masked snippet. It opens the message in a new tab where
    there is a link, and is plain text where there is none.
  - Each tab keeps its own query and results while the other is open.
- **Settings → Chat bots:**
  - **Make searchable** on every binding. It shows the applied retention, the
    audience rule, who switched it on and when, the Telegram caveats, and an
    amber line when the server has it off.
  - **Searchable chat** (`ChatSearchSettings.vue`) shows the retention asked
    for, the ceiling and what applies.
- **Assistant:** a chat source chip (messages icon, when it was said) and a
  "From chat" group in the thread's sources.

## Operations

| Env | Default | Meaning |
| --- | --- | --- |
| `CHAT_SEARCH_ENABLED` | `true` | `false`: the switch is refused and nothing new is kept; what was kept stays searchable until it expires |
| `CHAT_SEARCH_RETENTION_DAYS` | `90` | ceiling; a workspace may only shorten it |
| `CHAT_SEARCH_WINDOW_MESSAGES` | `20` | messages per window |
| `CHAT_SEARCH_WINDOW_GAP_MIN` | `30` | a silence this long starts a new window |
| `CHAT_SEARCH_SETTLE_MIN` | `10` | a thread's last window is packed once it is quiet this long |
| `CHAT_SEARCH_TICK_SEC` | `60` | the worker's indexing tick (retention runs on the API's 60-second answer sweeper) |

- **The migration (`20261125100000_chat_search`) is additive.** It adds two
  tables, two binding columns and one settings column. The previous release
  ignores them, so a code rollback is safe. Rolling back leaves kept messages
  in place until the next release's sweep or a manual delete.
- **Telegram** delivers ordinary group messages only with privacy mode off in
  @BotFather or with the bot as a group admin. The settings hint says so.
- **The `ChatChunk` vector index** is created at the API's schema step with
  `EMBEDDINGS_DIM`. A dimension change rebuilds it, as it does the page index.

## Deliberate deferrals

- **Time/Mattermost permalinks.** The issue planned a link to the thread root
  there too. Only Telegram supergroups link today; other hits render as plain
  text.
- **No audit row for the switch.** The issue planned
  `chat.search_enabled`/`chat.search_disabled`. Who and when are on the
  binding (`searchableBy`/`searchableAt`), as they are for listening and the
  automatic harvest, and neither of those is audited either.
- **No filters on the Chat tab.** The API takes `projectIds`, `bindingIds` and
  a time span; the web sends only the query.
- **Unbound chats and DMs** with the bot are never kept for search.
- **No backfill** of history from before the switch.
- **`purgeExpired` has no spec.** Its SQL (whole chunks by `last_at`, loose
  messages by `sent_at`, the per-workspace cutoff) is exercised by nothing
  but production. No spec checks that both stores are empty after a purge
  either; the reap is unit-tested against a mock graph.

## Verification

- Unit (`apps/api/test/`):
  - `chat-messages.spec.ts`: masked on write, edit and delete drop the
    chunk, `/forget` drops each chunk once, the retention clamp, and the
    switch (notice first, refused while off, off purges at once);
  - `chat-index.spec.ts`: windowing (gap, size, settle), author labels, the
    guarded pack (an edit under it gives the vector back), the orphan reap;
  - `chat-search.spec.ts`: ACL before retrieval, filters only narrow, the
    final join;
  - `chat-search-tools.spec.ts`: offered only when asked, named by the
    researcher and the author, audience clamp and project pin in a group turn,
    untrusted wrapping, a chat `[S#]` surviving `finalizeCitations`;
  - `mcp-http.spec.ts`: `knowledge_search_chat` is read-only and runs for a
    read key, under the caller's scope.

  The buffer's guard spec, `chat-buffer.spec.ts`, is unchanged.
- e2e against live infra (`pnpm --filter @knowledge/api run test:e2e`, not in
  CI; needs the embeddings provider `apps/api/.env` names):
  - `chat-search.e2e-spec.ts`: real people with real keys, five bindings. A
    restricted project's chat is found by its grantee and hidden from a member
    without a grant. A guest finds only their granted project's chat and never
    a project-less group. Snippets are masked. A stranger gets 403. The
    availability route agrees with the search.
- The web was checked in Chrome at desktop and narrow widths, in ru:
  `/search?tab=chat` and Settings → Chat bots against a seeded binding.
