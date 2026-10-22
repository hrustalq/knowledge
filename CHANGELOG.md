# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with two additions this project needs — **Breaking** and **Operations** — and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
narrowed in [docs/versioning.md](docs/versioning.md).

`[Unreleased]` is work merged to `dev` that is **built, tested and not serving
traffic**. A release promotes it to `main`; production moves only when a `vX.Y.Z`
tag is pushed. Entries are written
in the pull request that introduces them — see
[docs/templates/changelog-entry.md](docs/templates/changelog-entry.md).

## [Unreleased]

### Added

- Solved Zendesk tickets can be harvested into reviewed captures (#383). Add a Zendesk connector with
  your Zendesk address, an agent's `email:api-token` and a harvest tag (default `knowledge`), then
  create a Zendesk webhook pointed at the connector's address and a trigger, *Ticket status changed to
  Solved* with the tag, whose *Notify webhook* body is the JSON the setup dialog shows. When a linked
  editor solves a tagged ticket, its public replies and internal notes are masked and proposed as
  captures in their name. Nothing is written back to Zendesk.

- Linear issues can be harvested into reviewed captures (#382). Add a Linear connector under
  Settings → Connectors with a personal API key and a harvest label (default `knowledge`), then add a
  webhook on Issues in Linear pointed at the connector's address and paste its signing secret. When a
  linked editor completes an issue that carries the label, its description and comments are masked
  and proposed as captures in their name, and they get one notification with the counts. An issue
  completed by someone who is not mapped to a member, or is not an editor, is not harvested. Each
  issue is harvested at most once, and nothing is written back to Linear.

- Slack is a chat-bot platform (#380). A workspace admin connects an internal Slack app with its bot
  token and signing secret under Settings → Chat bots, then pastes the address shown on the bot's card
  as the app's Request URL for Event Subscriptions and Interactivity. The bot answers a mention in a
  channel (in the message's thread) and a direct message, as the linked person, with citations, 👍/👎
  and Save, as it does on Time and Mattermost. `capture` said in a thread, or 📌 on any of its
  messages, harvests the thread into reviewed captures. The chat reply gives counts and an inbox
  link. Every request Slack sends is checked against the signing secret, and an unsigned, forged or
  more than five-minute-old request is refused.

- A chat search result from a Time or Mattermost channel now links to its thread, as Telegram supergroup
  results already did (#407). On the Chat tab of search and in an assistant answer's chat citation, the
  result opens the thread's first post on the chat server in a new tab. Direct chats still have no link.
  A channel that was made searchable before this release gets its link after the next message posted in
  it.

### Operations

- Migration `20261203100000_connector_harvests` adds the `connector_harvests` table, one row per
  harvested issue. It is a new table the previous release never reads, so a rollback keeps working; a
  Linear connector saved on this release is unknown to the previous one and shows as an unknown kind.
- Migration `20261202100000_chat_signing_secret` adds a nullable `chat_integrations.signing_secret`
  (the Slack app's signing secret, encrypted with `SETTINGS_ENCRYPTION_KEY`). It is additive, so a
  rollback keeps working; a Slack bot saved on this release stops answering on the previous one,
  which has no Slack adapter. No new env var: `CHAT_ENABLED` covers Slack too.
- Migration `20261201100000_chat_binding_team` adds a nullable `chat_channel_bindings.team_name`. It is
  additive, and the previous release ignores it, so a rollback keeps working. The bot fills it once per
  searchable Time/Mattermost channel, at the first message it keeps there, with two calls to the chat
  server. A team renamed after that keeps the old name in the column. Set the column to `NULL` and the
  next message resolves the new name.

## [0.32.1] — 2026-10-22

### Fixed

- A page's actions no longer take a second strip under the breadcrumbs (#455). They now sit at the right
  end of the breadcrumb row: Watch, Share and Access as icons, then Copy page, Edit and ⋯, all the same
  height on one line. History and Graph left the bar because the rail beside the page already holds them,
  and Export and the glossary switch are still in ⋯ (Export ▸, View ▸). On a narrow window Copy page and
  Edit show only their icons. The editor's bar is unchanged.

## [0.32.0] — 2026-10-22

### Added

- A ticket in a connected tracker can now ask the knowledge base for documentation (#433). Give an
  "A tracker ticket opens or changes" agent trigger a **Ticket labels** filter (for example `docs`), or
  apply the new **Docs from tickets** recipe, and turn it on. A matching ticket on GitHub, GitLab or Jira
  then starts the new **Scribe** agent once. The Scribe reads the ticket, searches the pages its owner can
  open, and proposes up to three new or rewritten pages. Each proposal is a merge request that links back
  to the ticket, and the ticket gets one comment listing them. Nothing is published until someone merges
  it. The trigger starts nothing for a ticket attached to a page its owner cannot open, or for a ticket
  labelled before the trigger existed. Jira tickets carrying only the trigger's label are now picked up as
  well, not just those with the connector's handoff label.
- Security → Audit now records each change to a chat group's three switches (#408): making it searchable
  or turning search off, keeping messages for /capture or stopping, and turning the automatic thread
  harvest on or off. Each row names the admin, the group binding and the workspace. Turning one on also
  records the retention or quiet period that applied at that moment. A switch that is refused, for
  example because the bot could not post its notice in the group, records nothing. Until now the binding
  showed only who last turned a switch on, so once a switch went off and on again the earlier history
  was lost.

### Changed

- Agent triggers on tracker tickets (`work-item.updated`, now labelled "A tracker ticket opens or
  changes") also fire when a ticket is first seen, and when a poll sees a Jira or GitLab ticket's labels
  change. Before, they fired only when a ticket was
  closed or reopened, or (on GitHub) relabelled (#433).
- An agent trigger now starts nothing when its owner cannot open the page the event is about. Before,
  it started a run that then skipped the page (#433).
- A page's actions now sit in a bar directly under the breadcrumbs, as in Confluence, instead of sharing
  a row with the title (#441). The bar stays in place while the page scrolls. It shows labels when it is
  wide and icons when it is narrow (an open sidebar narrows it too), and every button keeps its name for
  screen readers and as a tooltip. New quick buttons for History, Graph and Export open the same views as
  the rail widgets and the menu. The ⋯ menu now groups items into submenus: Export ▸ opens the export
  dialog on the format you pick, and View ▸ holds Full width and Glossary links.
- The editor (`/documents/:id/edit`, `/create`) now shows the breadcrumb trail. Its actions use the same
  bar, so Edit and Publish stay in the same place when you switch between reading and writing. The
  formatting toolbar sits directly beneath. The project name that used to head the editor is gone; the
  trail names it. The editor's ⋯ menu has Changes ▸ (review or discard unpublished edits, with a
  confirmation) and Template ▸ (insert a template at the cursor, or save the page as one). On a phone,
  Settings and Cancel are now icons in the bar instead of items in the menu.
- Submenus in every dropdown open beside their item, flip to the other side near the screen edge, and
  animate like the menu they come from. They are no longer clipped by the menu that contains them.

### Fixed

- Search in the app (the search sheet and `/search`) listed a page once for every section that matched,
  so one long page could take several rows and push other pages past the limit (#443). Each page now
  appears once, showing its best-matching section, and the limit counts pages: 20 matching pages still
  give 20 rows. The row's snippet now opens around the first matching word instead of at the section's
  first 300 characters, and the matched words are highlighted, including other forms of the word
  (`сервис` marks `сервиса`). A page found only by meaning shows a plain snippet with nothing marked.
  API callers opt in with `groupBy: "page"` on `POST /v1/search`, which adds `snippetParts` to each
  result; without it the response is unchanged, and so are MCP `knowledge_search` and the assistant's
  `search_knowledge`.
- The activity ledger on a profile page drew the year at a fixed small size, so on a desktop screen it
  filled under half its card and its days were hard to hover or click (#440). The year now stretches to
  the card's width, with days between 12 and 24px. On a narrow screen it still scrolls, opening on the
  current week. The Mon / Wed / Fri labels were one row too low (Mon sat beside Tuesday) and now line
  up with their rows.
- Mermaid flowcharts showed their boxes and arrows with no text: every node name and edge label was
  missing on the page view, in the editor, in the assistant and docs, and on share links and published
  sites (#438). Labels are now drawn as SVG text, so they survive sanitizing. An
  `%%{init: {"flowchart": {"htmlLabels": false}}}%%` line is no longer needed but does no harm.
- Sequence diagrams drew every participant twice, again under the lifelines, which read as duplicate
  entities (#438). Each participant now appears once, at the top, on every render site including export.
  Add `%%{init: {"sequence": {"mirrorActors": true}}}%%` to a diagram to bring the bottom row back.
- Commenting on a list or a table from the margin control looked like it failed: the comment was saved
  but appeared nowhere (#439). The control now targets one list item or one table row and highlights
  the comment on exactly that text. Comments with no place on the text, posted on the page as a whole
  or on a passage that has since been edited away, are listed in a new **Comments** widget in the page
  rail, where they can be replied to and resolved. Comments already saved this way show up there too.
- After pressing Comment, typing went nowhere until the box was clicked (#439). The composer now has
  focus when it opens.

## [0.31.0] — 2026-10-21

### Added

- A reported issue, a knowledge conflict, a page's verification flag or a page can be handed off to a
  GitHub repository connector as an issue (#424): `POST /v1/work-items/handoff` creates the issue, or
  attaches an existing one (`#45`, `org/repo#45` or its URL). The issue carries the object's title, a link
  back and a `knowledge-ref:` footer, but no page content. A restricted page is named by its id. Status
  then moves both ways. Closing the issue resolves the report or conflict, or dismisses it if closed as
  not planned. Resolving, dismissing or verifying here closes the issue. A conflict raised again, or a page
  flagged again, reopens the same issue. A failed transition is retried five times, then shows its error
  until someone retries it (`POST /v1/connectors/:id/work-items/:workItemId/retry`). Only a GitHub account
  mapped to an editor can clear a page's flag from the tracker. No tracker action ever verifies a page.
- `GET /v1/work-items?workspaceId&sourceKind&sourceId` lists the issues handed off for one object.
- Handoff rules (#424) under **Knowledge health → Settings** (admins). Reported issues (high priority,
  medium and high, or all), open conflicts, or flagged pages (outdated, or with a check requested too) are
  handed off automatically into each project's tracker route. A project without a route gets no tickets. All
  rules are off by default. `GET|PUT /v1/work-items/rules` reads and sets them.
- MCP `knowledge_handoff_work_item` (editor) hands an object off or attaches an existing ticket. It is a write
  tool, so read-only keys do not see it (#424).
- Agent triggers can fire on **A handed-off ticket changes** (`work-item.updated`): closed, reopened or
  relabelled in its tracker (#424).
- A page's owner is notified when the ticket for their page, report or conflict is closed in the tracker
  (#424). This is in the verification category, so muting verification mutes it too.
- **Send to tracker** in the web app (#424), on every open report, every open conflict, and the verification
  bar of a flagged page. It creates a ticket or attaches an existing one. A chip then shows the ticket's key
  and status (`BILL-123 · In progress`) and links to the tracker. A transition that kept failing shows
  the tracker's error with a Retry button. `/knowledge-health` gains a **Handed off** filter, the ticket under
  each page's state, and a bulk **Send to tracker**. A tracker connector gains a **Tracker** tab, where an
  admin can:
  - route projects to it, with the Jira project and issue type or a GitHub board;
  - override the status map, with the defaults shown;
  - map the tracker accounts it has seen to members. They are mapped for attribution only; nobody is
    assigned anything.
- Jira Cloud connectors are trackers too (#424). A handoff creates a ticket in the tracker route's Jira project,
  or in the connector's new **Default project key**, with the route's issue type (default `Task`). An existing
  ticket can be attached by `BILL-123` or its browse URL. Status moves through Jira's own workflow
  transitions. The connector's JQL is now optional: leave it empty to use Jira only as a tracker. A signed
  Jira webhook on `/v1/connectors/:id/webhook` updates a handed-off ticket within seconds. Without one,
  polling picks the change up.
- GitLab repository connectors (`markdown-git`, `codebase`) are trackers too (#424), on gitlab.com or a
  self-hosted instance whose host name contains `gitlab`, and with nested groups. Handoff opens a GitLab issue,
  and done or won't do closes it. An existing issue can be attached by `#45`, `group/repo#45` or its URL.
  An `Issue Hook` on the connector's webhook, checked against its secret token, updates a handed-off
  issue at once. The Work items tab and the assistant's `task_*` tools work on GitLab connectors too.
- A knowledge project can be routed to one tracker connector (#424): `GET|PUT|DELETE
  /v1/projects/:id/tracker-route` sets the connector, the Jira project key and issue type, and optionally a
  GitHub **organization** board URL. A project's handoffs go there, and a project without a route has the
  connector picked by hand. With a board, a handed-off issue's card is added to it, and its Status column
  follows the ticket (Todo, In Progress, Done). That write is best effort; the issue's own state is the
  status. A user-owned board is refused, because the GitHub App cannot reach it. Moving a card on the board
  refreshes the issue's board names in the projection.
- The assistant can record a decision (`capture_decision`) and mark a page outdated (`mark_outdated`) in
  Agent mode (#425). When something wide-reaching is left open, it asks instead of guessing, one question per
  turn. For a decision that is the project, the related page and a reviewer (only when a page is linked). For
  the outdated flag it is whether to include the subpages, which to leave alone, and why. The options come
  from the workspace (projects, pages and members you can see), never from the model. A suggested option is
  marked and pre-selected. A decision becomes a merge request through the same path as an MCP capture, and
  the picked reviewer is assigned to it. Typing a message instead of answering leaves the flow, and nothing
  is written.
- `POST /v1/assistant/threads/:id/messages` (and its streaming twin) accepts `answer: { flow, questionId,
  value }` beside the readable `content`. It is stored on the message and returned as `answer`. An answer to
  anything but the open question, or the one answered last, is refused with 409 `flow-answer-stale` (#425).
- `ask_user` options take `recommended`, at most one per field, and the tool now asks for one question per
  form (#425).
- In the assistant pane, a question from one of these flows shows "Question 2 of 3", and its suggested option
  is pre-selected and focused, so accepting every suggestion is a run of Enter presses (#425). An answered
  question collapses to one line, and the answer is drawn as an answer, not as a chat message. While the
  next question is open, the one answered just before it has a **Change** action. A changed answer, and a
  question it made unnecessary, stay in the transcript struck through, never silently replaced. Turns that
  ask, and the turn reporting what the flow did, show no confidence badge, rating or reply actions. The tool
  line reads "Asked about the decision" while it is asking, and says so when the write fails instead of
  claiming it happened. A form answered late from another tab reloads the thread to the open question.
- MCP `knowledge_capture_decision` no longer needs `projectId` (#425). Without it, the person is asked which
  project, which related page and which reviewer, with the same options and the same suggested choice as in
  the assistant pane. Over HTTP the tool returns `status: "needs_input"` with the question and
  `answersSoFar`; the agent asks the person and calls again with `answers`. Keys it could not apply come back
  under `ignored`. A stdio client with its own form (Claude Code, Cursor) is asked directly, and declining
  returns `status: "cancelled"` with nothing written. The SKILL.md gains a **Questions for the person**
  playbook.

### Changed

- Work-item lists (the connector's Work items tab, MCP `knowledge_list_work_items`, the assistant's `task_*`
  tools) leave out an item attached to a page the caller cannot open (#424).
- The Jira connector reads issues through `/rest/api/3/search/jql`. The `/rest/api/3/search` endpoint it
  used before is deprecated on Jira Cloud. Test connection now shows Jira's approximate match count (#424).
- Linking a work item (`POST /v1/connectors/:id/work-items/:workItemId/link`) also accepts an anchor
  (`sourceKind` + `sourceId`), and unlinking drops it. Unlinking never closes the issue (#424).
- An error frame on the assistant's streaming endpoint carries `details`, the same as the error body of every
  other route (a 409's `reason`, for one). Before, the extras were dropped (#425).
- MCP `knowledge_flag_document` with `state: "outdated"` now asks first when the page has subpages (this
  page, or the subtree minus the pages to leave alone) or when no `note` was given, the same way (#425). A
  page with no subpages and a `note` is flagged at once, as before. The reply lists `marked` and `failed`
  pages instead of `verification` and `ownerId`. The flag's workspace is the page's own, whatever
  `workspaceId` says. `state: "requested"` is unchanged.

- Page text fills the content column again, on every page, the public share links and published sites
  included (#422). In 0.30.1 paragraphs and lists stopped at about 65 characters, which left a wide screen
  half empty beside the headings. If you prefer the narrow reading width, uncheck **Full width** in a page's
  `⋯` menu. The choice applies to every page in the app and is remembered in this browser.

### Operations

- Migration `20261127100000_tracker_handoff` prepares tracker handoff (#424): new nullable columns on
  `connector_work_items`, `connectors` and `workspace_settings`, and a new `project_tracker_routes` table.
  It is expand-only and the previous image runs against it unchanged, so a code rollback is safe. It
  also anchors each GitHub issue already attached to a page to that page (the most recently updated
  one per connector and page). The page's other attached issues stay on its rail, as before.
- Migration `20261128100000_work_item_actor` adds a nullable `connector_work_items.external_actor_id`, expand-only
  (#424).
- Migration `20261129100000_tracker_route_board_url` adds a nullable `project_tracker_routes.board_url`,
  expand-only (#424).
- Migration `20261130100000_assistant_message_answer` adds a nullable `assistant_messages.answer`, expand-only
  with no backfill. The previous image ignores it, so a code rollback is safe (#425).
- The GitHub App now asks for **Organization projects: write**, up from read, and the **Projects v2 item**
  webhook event (#424). Change both on the App's settings page, then have each organization accept the new
  permission. Until then board writes fail quietly and everything else works.
- `WORK_ITEM_AUTOCREATE_MAX_PER_TICK` (default `20`) caps the tickets that handoff rules create per sync tick,
  across all workspaces. `0` turns rule-driven handoff off. It has a default, so no deploy change is
  needed (#424).
- Tracker handoff release checklist (#424; details in `docs/features/32-connector-work-items.md` → Setup):
  1. Set `GH_APP_WEBHOOK_SECRET` in the GitHub `production` environment. It has been empty in prod, so the
     App webhook refused every delivery.
  2. On the GitHub App: turn **Webhook Active** on, with URL
     `https://knowledge.hrustalq.dev/api/v1/connectors/github/webhook` and the same secret. Raise
     **Organization projects** to Read and write, and subscribe to **Projects v2 item**.
  3. Have each installation accept the new permissions.
  4. From the laptop, check that one delivery returns 202 in the App's "Recent deliveries".
  Polling keeps everything in sync if any of this is late; the webhook only makes it faster.
- Status sync runs in the API process every `WORK_ITEM_SYNC_TICK_MS` (default `15000`). Set
  `WORK_ITEM_SYNC_ENABLED=false` to stop it; handoff still works. Both variables have defaults, so no
  deploy change is needed. Sync works by polling. The GitHub App webhook only makes it faster.

## [0.30.1] — 2026-10-21

### Changed

- Pages fill the content column. This covers the public site and share pages, `/conflicts` and several
  settings pages, which used to sit in a narrow centred box (#418). Running text keeps a readable line
  length of about 65 characters. Headings, tables, code and diagrams use the full width.
- Scrollbars are thin, and they are fainter inside dialogs, popovers, rails and code panels. Tab rows and
  breadcrumbs hide the bar and fade at the edge where there is more to scroll (#418).
- The web app downloads only the active language's text, so the first page load is about half the size.
  Switching language fetches the other one (#418). The graph, revision history and API reference on a page
  load when they are opened.
- Confirmations use the app's own dialog instead of the browser's `confirm()` box. Tabs behave the same on
  every page, and the arrow keys move between them (#418).
- Sidebar, settings rail, filter rail and editor AI panel slide without easing the page width; the page
  content moves once (#418).
- MCP `knowledge_search` returns at most 8 hits when the caller sets no
  `limit` (it was 20), and lists each page once, with its best-matching
  passage (#416). An agent that relied on 20 hits per call passes
  `limit: 20` explicitly. Even then, a page matched in several passages
  appears once, so it may get fewer entries than it asked for.

### Fixed

- Notifications read as sentences ("edited this page") instead of raw event types like
  `revision.finalized`. The activity feed labels 47 actions it used to print as codes, such as
  `document.archived` (#418).
- On a phone, every page load no longer hydrates with a mismatch. The assistant page and user chips no
  longer mismatch at desktop width either (#418).
- A list that fails to load shows an error with a Retry button instead of "nothing here yet". This covers
  notifications, merge requests, workflows, projects and connectors (#418).
- Accessibility (#418):
  - Error text is readable in dark mode (it was about 1.9:1).
  - Focus rings meet 3:1.
  - The mobile menu traps focus and closes on Escape.
  - There is a skip link, and every page, public ones included, has a main landmark.
  - Unlabelled buttons, selects, checkboxes and inputs are named.
  - Muted timestamps and inline links meet contrast.
  - Status dots carry a text label.
  - Code blocks and wide tables can be scrolled from the keyboard.
  - Buttons get a 44 px hit area on touch screens.
- Verification state no longer uses the indexing dot's colours. It shows as a small diamond, so "outdated"
  can't be mistaken for "indexing" (#418).
- Headings h2–h4 render at their intended weights. Only 600 and 700 were being loaded, so they all looked
  like h1 (#418).
- The assistant and MCP agents no longer read unrelated pages with every
  search (#416). In production, each assistant search added 26–29 pages that
  only shared an entity with a hit, about the whole workspace and
  roughly 9 KB of a 14 KB result, none of them citable. A page also appeared
  once per matching passage, and a page that shared just two common words
  with the question could still reach the top 5 («Навигация и вкладки» for
  «Где в системе определяются права и роли пользователей?»).
  - The assistant's search no longer attaches graph-related pages. It still
    walks the graph when it chooses to, through its relation tools.
  - Each page appears once per search, in both the assistant and MCP.
  - A keyword match far below the best keyword match no longer counts. This
    applies to every hybrid and keyword search, the web search page included.

## [0.30.0] — 2026-10-21

### Added

- A workspace admin can make a bound Telegram, Time or Mattermost group
  **searchable** (#339, phase 1 of the chat search milestone). This is the
  `searchable` switch on `PATCH /v1/chat/bindings/:id`, and it is separate
  from *Keep messages for /capture*.
  - **Turning it on:** the bot first tells the group what it keeps, for how
    long, and that `/forget` works. If the bot cannot post that notice,
    nothing is switched on.
  - **What is kept:** from then on, people's messages are kept with emails,
    phone numbers, card numbers, ID numbers and secrets masked before
    anything is written. Edits are followed on every platform, and deletions
    on Time and Mattermost (Telegram never tells bots about deletions).
  - **Turning it off:** what was kept is deleted at once. Unbinding the group
    does the same, and `/forget` deletes the asker's own messages too.
  - **Retention:** messages are kept for at most `CHAT_SEARCH_RETENTION_DAYS`.
    A workspace can shorten that through `GET`/`PATCH
    /v1/chat/search-settings`.
  - **Indexing:** the worker packs each thread into windows of at most
    `CHAT_SEARCH_WINDOW_MESSAGES` messages, split at
    `CHAT_SEARCH_WINDOW_GAP_MIN` minutes of silence. It indexes a window
    once the thread has been quiet for `CHAT_SEARCH_SETTLE_MIN` minutes, or
    once the window is full, and embeds it into its own vector index (phase
    2). A window names no one, only `author-1`, `author-2`, and so on. An
    edit, a delete or `/forget` re-indexes the window that held the message.
  - **Search:** `POST /v1/chat/search` (phase 3) returns matching windows
    with the group's title, platform, time span and masked snippet. It ranks
    meaning and words together and links to the first message where the
    platform has links (Telegram supergroups). It returns only groups the
    caller may read:
    - a group bound to a project: whoever can see that project, so a
      restricted project's chat needs a grant on it;
    - a group bound to no project: workspace members, never guests.

    Chat results are kept apart from page results. Filters by project, group
    and time span only narrow what the caller may already read.
  - **Agents and bots** (phase 4) can search the same chats through
    `knowledge_search_chat` (MCP) and `search_chat` (the assistant).
    - **Offered only while the workspace has a searchable group**, and only
      to the Researcher and Author agents, which also answer in chat bots.
      Background agents never get it.
    - **Masked, cited and labelled.** Results are masked and wrapped as
      untrusted, and an answer cites a chat window as its own kind of
      source. The window opens in the messenger where the platform has
      links, and shows the group and time span in the sources panel.
    - **Group answers stay inside the group's audience.** A bot answering
      in a group searches only the chats of the group's project, and never
      a restricted project's chat.
  - **In the web app** (phase 5):
    - **Search has a Pages | Chat tab strip.** The Chat tab lists matching
      windows with the group, platform, time span, message count and masked
      snippet, and opens the message in Telegram where there is a link. It
      appears only for someone who may read a searchable group; that check
      is `GET /v1/chat/search`, under the same rules as the search itself.
      Page results are unchanged.
    - **Settings → Chat bots** gains a **Make searchable** switch on every
      group, on all three platforms. It names the retention period, the
      audience and who switched it on and when. On Telegram it also says
      privacy mode must be off and that deletions are not followed. The page
      also gets a **Searchable chat** retention setting that shows what the
      workspace asked for, the deployment's ceiling and what applies.
    - The *Keep messages for /capture* hint no longer says "never
      searchable". It now says kept messages serve only `/capture`, and that
      searching is the separate switch.

### Fixed

- Keyword search (`FULLTEXT_PROVIDER=opensearch`) no longer ranks pages on
  stopwords (#400). A Russian question such as «От какой ветки базироваться
  при разработке фичи?» matched any chunk containing «от», «при» or «какой»,
  and an English rewrite matched an env-var table on the single word `Base`.
  Chunk text is now indexed with Russian and English stemming and stopwords,
  so «ветки» finds «ветка». A query of more than two words must share 60% of
  its meaningful words (rounded down) with a chunk before the keyword leg
  returns it.
- Search no longer pads its results with pages that have nothing to do with
  the question (#401). Every search used to return its full limit, so the
  assistant cited, as sources, pages that only loosely resembled the
  question. A page also ranked high just because both semantic and keyword
  search listed it somewhere low, which put it above the page that actually
  answered.
  - A semantic match now counts only if it is close to the best one: at
    least 0.9 of the top similarity by default.
  - Where `SEARCH_MIN_COSINE` is set, a match must also clear that absolute
    similarity. A question nothing in the workspace answers then comes back
    empty.
  - A search may now return fewer results than its limit, or none.
  - Admins can override both values per workspace under **Knowledge health →
    Settings → Search ranking**, and `make tune` proposes them.

  On a replay of production searches, the right page came first for 97% of
  page titles, up from 55%, and off-topic questions returned nothing instead
  of 10 pages.
- The assistant no longer translates or pads your question before searching
  (#402). Asked «От какой ветки базироваться при разработке фичи?», it
  searched `feature development which branch base from base branch develop
  main branching strategy`, and the English words matched code and table
  headers instead of the Russian page that answered. The search tools in the
  app and over MCP (`knowledge_search`, `knowledge_search_chat`) now tell the
  model to search with the user's own words and language, and to reword only
  to resolve "it" or "that page" from earlier in the conversation.
- Assistant answers are no longer marked **low** confidence just because
  keyword search is on (#403). With `FULLTEXT_PROVIDER=opensearch`, every
  answer carried a "weak retrieval" reason worth −0.2, because the check read
  the combined ranking score (at most about 0.03) against a semantic
  similarity threshold of 0.35. It now reads the semantic similarity of the
  best page the answer was given, whichever search legs ran. A page only
  keyword search found does not count either way. Search results gain an
  optional `vectorScore`, that similarity. Confidence already stored on past
  answers is not recomputed.
- **Knowledge health → Settings** no longer goes blank when you type a number
  into any field (#401). Typing into a number box handed the form a number
  where it expected text, so the form crashed on the first keystroke and
  nothing could be saved from it.

### Operations

- **New env vars:**
  - `CHAT_SEARCH_ENABLED` (default `true`)
  - `CHAT_SEARCH_RETENTION_DAYS` (default `90`)
  - `CHAT_SEARCH_WINDOW_MESSAGES` (default `20`)
  - `CHAT_SEARCH_WINDOW_GAP_MIN` (default `30`)
  - `CHAT_SEARCH_SETTLE_MIN` (default `10`)
  - `CHAT_SEARCH_TICK_SEC` (default `60`)

  Nothing is kept until an admin turns a group on.
- **ArcadeDB:** the worker creates a `ChatChunk` vertex type and a second
  `LSM_VECTOR` index (`ChatChunk[embedding]`) at boot. It is empty until a
  group is made searchable. A change of `EMBEDDINGS_DIM` rebuilds it as it
  does the page index, but chat windows are not re-embedded, so their
  vectors drop out of the index until a later edit re-packs them.
- **Migration:** `20261125100000_chat_search` adds `chat_messages`,
  `chat_chunks` (with a generated `tsvector` column and a GIN index), two
  nullable columns on `chat_channel_bindings` and one on
  `workspace_settings`. It is additive, so a rollback needs no down
  migration.
- **Telegram:** a bot reports edits only after its webhook is set again.
  Press **Test** on each Telegram bot after deploying.
- **Retention sweep:** the chat sweeper's one-minute tick now also purges
  kept chat (the harvest buffer and searchable groups) while
  `CHAT_ENABLED=false`, because a retention is a promise about rows already
  written.
- **Search relevance floor (#401):**
  - **New env var:** `SEARCH_MIN_COSINE` (default `0`, off). Production
    embeds with bge-m3 and should run `0.4`, which `.env.production.example`
    now gives. Run `gh variable set SEARCH_MIN_COSINE --env production --body
    0.4` before tagging, or the deploy refuses the missing key. If embeddings
    roll back to the stub, set it back to `0`, or every search comes back
    empty.
  - **Migration:** `20261126100000_search_floor` adds two nullable columns to
    `knowledge_health_settings`. It is additive and survives a code rollback.
  - The `search.executed` backtest line gains `vectorFloored`: how many
    vector hits the floor dropped.
- **Keyword search backfill (#400):** on its first search after the deploy,
  the API (or the worker) adds the ru/en fields to the OpenSearch index and
  starts a background `_update_by_query` over the rows that lack them. Nothing
  is re-embedded. Until it finishes, typically seconds to a few minutes, the
  keyword leg misses older pages, and vector search still finds them. The
  log line is `Re-analyzing <n> row(s) of <index>`. Rolling back is safe: the
  previous image ignores the new fields.

## [0.29.1] — 2026-10-20

### Fixed

- The API image builds again (#392). The v0.29.0 tag never reached
  production: the deploy stopped at **Build api image**. The new build-time
  check that the learner's modules resolve imported them with no environment
  set, so env validation refused the import. The check now gets placeholder
  values for that one command. v0.29.0's changes ship unchanged in the next
  version.

## [0.29.0] — 2026-10-20

### Added

- Agents can now learn from findings people keep dismissing (#305). A new
  learner process finds dismissed findings of one agent in one project that
  are the same mistake: three or more within 30 days, dismissed by at least
  two people. The new `coach` agent then drafts one correction from them,
  which lands under **Settings → AI → Learnings** as a *proposed* learning
  with a **Derived** badge and its evidence. Each finding in the evidence is
  shown only to someone who can open every page it cites; the others appear
  as "+N not visible to you". A later similar dismissal is added to the same
  learning instead of creating another. Findings that cite a restricted page,
  or a page under one, are never used. A derived learning reaches no prompt
  until an admin approves it, and derived learnings never take more than
  half of an agent's learning budget or push out a hand-written one. When an
  active learning has 20 runs on each side of its approval and dismissals
  did not drop, it is flagged as proposed for archiving with the before and
  after counts. The admin archives it or presses **Keep active**
  (`PATCH /v1/ai/agents/learnings/:id` with `keepActive: true`). The learner
  never activates or archives anything itself. `make backtest
  ARGS="--learner"` measures the clustering threshold for the configured
  embedding model.
- Coding agents connected over MCP (Claude Code, Cursor and others) now get
  the team's guidance (#305). A learning can teach **Agents over MCP**. Once
  an admin approves it, it appears in the instructions the MCP server sends
  when a client connects, and in `knowledge://skill` under **Team guidance**.
  A key narrowed to projects sees only those projects' learnings, plus the
  workspace-wide ones. Learnings for every agent are not sent to MCP clients.
  The learner also drafts MCP learnings from repeated failures: captures a
  person rejected, captured merge requests closed unmerged, and answers built
  from `knowledge_search` that were downvoted. A capture dropped as a
  duplicate does not count. The key `mcp` is now reserved and cannot be used
  for a custom agent.
- Search ranking can be tuned per workspace, and `make tune` proposes how
  (#305). **Knowledge health → Settings** has a new **Search ranking** group:
  the fusion constant (RRF k, default 60) and a weight for each page state
  that trust-aware ranking multiplies scores by. Each shows what is asked for
  and what applies; a weight left empty keeps its default, and each weight is
  held between 0.1 and 1.25. `make tune ARGS="--workspace <id>"` replays the
  workspace's votes (or `--feedback <file>`) and its pages' titles through
  search once, then tries other values in memory. It proposes a change only
  when it raises MRR on the votes, costs known-item recall@5 at most one
  point, and also holds on a 30% holdout. It does the same for the capture
  dedupe and amend thresholds, never accepting more dropped new facts or more
  wrong-page amends than today. It prints the report and the `PATCH` bodies
  to apply, appends the report to `logs/tune-<date>.jsonl`, and writes no
  setting. With no override, search ranks exactly as before.

- The in-app docs (**Settings → Docs**) have a **Learning loop** article
  under Administration. It covers what the Agents tab counts, how a derived
  learning is drafted and approved, guidance for MCP agents, the search knobs
  and `make tune`, and how to turn the learner on (#305).

### Changed

- Vector search now asks ArcadeDB for the nearest chunks through an HNSW index
  (`LSM_VECTOR`) instead of downloading up to 5,000 chunk vectors and ranking
  them in the API (#304). The workspace, the live projection and page
  restrictions are applied inside the nearest-neighbour search, so another
  workspace, an old revision or a hidden page can no longer take a result
  slot, and a workspace past 5,000 chunks is no longer ranked on an arbitrary
  subset. This covers workspace search, the assistant's and agents'
  retrieval, capture dedupe and a published site's Ask. On a copy of the
  local demo corpus (5,936 chunks), one read went from 71 MB and ~1.5 s p95
  to ~18 KB and ~32 ms p95, at recall@10 0.988 against the exact ranking.
  The capture calibration backtest and the doc-quality duplicate check now
  read every chunk instead of stopping at 5,000.

### Operations

- ArcadeDB is pinned to the `26.10.2` release by tag and digest in both
  compose files (#304), replacing `latest`. Production runs a
  `26.11.1-SNAPSHOT` nightly, so this moves it back one minor version, to the
  newest release. A volume written by `26.11.1-SNAPSHOT` (build of
  2026-10-19) and one written by `26.9.1-SNAPSHOT` both opened on `26.10.2`
  in a test, with their data and indexes intact; back up the `arcadedata`
  volume before deploying anyway. The deploy recreates the `arcadedb`
  container. Locally, `make infra-up` pulls the pinned image: the old
  `26.9.1-SNAPSHOT` rejects the filtered vector query, and search then falls
  back to the scan.
- The worker builds the chunk vector index on its first boot after the deploy
  (`ensureSchema`; 6,266 vectors took 1.8 s). Until then, and whenever no
  index of the configured dimension exists, vector search falls back to the
  old scan. Run `make graph-live-backfill` once afterwards, so that chunks
  written before the live flag existed stop counting as live: the local demo
  workspace had 1,745 of them. Whether production has any is not yet known.
- Changing `EMBEDDINGS_DIM` now drops and rebuilds the index on the worker's
  next boot. Vectors of the old length stay stored but are never ranked, and
  the stale sweeper re-embeds their pages as before. A wrong `EMBEDDINGS_DIM`
  now fails every indexing job with "Vector dimension does not match index
  dimension" instead of indexing chunks that search never finds.
- **Rollback:** the previous app version still works on `26.10.2` and ignores
  the index, which ArcadeDB keeps up to date. Rolling the app back **and**
  changing `EMBEDDINGS_DIM` at once is the exception: the old worker does not
  rebuild the index, so every chunk write fails until you run
  ``DROP INDEX `Chunk[embedding]` `` in ArcadeDB. Rolling the image back to a
  snapshot also works: `26.11.1-SNAPSHOT` serves the index, and
  `26.9.1-SNAPSHOT` opens it but rejects the filtered query, so search scans.
- New process `learner` (#305): a fifth entrypoint of the API image,
  `node dist/learner.main`, added to `docker-compose.prod.yml` under the
  compose profile `learner`. It starts only when `COMPOSE_PROFILES` names
  `learner`, and it works only with `LEARNER_ENABLED=true`. Otherwise it boots
  and idles. Locally run it with `make dev-learner`. It reads Postgres, embeds
  through `EMBEDDINGS_*` and calls the `coach` agent through the workspace's
  provider, billed as `coach` usage. It needs no Redis, listens on no port and
  consumes no queue.
- New env vars, all with defaults, so nothing needs to be set to deploy:
  - `LEARNER_ENABLED` (`false`)
  - `LEARNER_TICK_MS` (`900000`): each workspace gets one pass a day at most
  - `LEARNER_WINDOW_DAYS` (`30`)
  - `LEARNER_CLUSTER_THRESHOLD` (`0.7`, calibrated on bge-m3; re-run the
    calibration if the embedding model changes)
  - `LEARNER_MIN_DISMISSALS` (`3`)
  - `LEARNER_MIN_PEOPLE` (`2`)
  - `LEARNER_MIN_RUNS` (`20`)

  They are commented out in `.env.production.example`, so the deploy's
  environment check asks for nothing new. Turning the learner on means
  setting `LEARNER_ENABLED=true` and adding `learner` to `COMPOSE_PROFILES` in
  the GitHub `production` environment.
- Migration `20261123100000_derived_learnings` adds three nullable columns to
  `agent_learnings`: `evidence`, `archive_proposed_at` and `archive_check`.
  It also widens the `source_kind` CHECK to allow `derived`. It is additive
  with no backfill and survives a code rollback, since the previous release
  ignores the columns and never writes `derived`. After a rollback, derived learnings
  still show as proposed learnings and an admin can archive them. (#305)
- Migration `20261124100000_search_knobs` adds two nullable columns to
  `knowledge_health_settings`: `rrf_k` and `trust_weights`. It is additive
  with no backfill, and null means the code default. It survives a code
  rollback: the previous release ignores the columns and ranks with its
  constants, so a saved override stops applying until the release returns.
  No new env vars. (#305)

## [0.28.0] — 2026-10-20

### Breaking

- `HTTP`: a session token (`ks_…`) in `?token=` is now refused with 401, as an
  API key already was. `?token=` takes only a single-use `kt_` ticket, and only
  on `GET /v1/events`. The attachment, import-image and avatar redirects no
  longer read `?token=` at all. (#102)
  **Migration:** send `Authorization: Bearer <token>`. For the event stream,
  trade the token for a ticket first with `POST /v1/auth/url-ticket`.

### Security

- The app's own pages now send `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
  `Cross-Origin-Opener-Policy: same-origin` (#277). Share links and published
  sites keep the headers their renders set, so a site's Ask widget stays
  embeddable where its `frame-ancestors` allows.
- Access logs and every log line written while a request is handled now show
  `?code=` and `?state=` as `[REDACTED]`, as they already did `?token=`. The
  SSO and GitHub App callbacks no longer put the identity provider's
  authorization code and state in a log, and neither do share-site and chat
  link codes. (#297)
- Attachment, import-image and avatar URLs in the web app no longer carry your
  session token. Those `<img>` and `<object>` requests now authenticate with the
  app's own session cookie, so the token can no longer end up in a proxy log,
  browser history or a pasted image link. (#102)

### Added

- Chat harvests now mask Russian identity numbers before any model reads a
  thread, as they already masked emails, phones and cards. An INN (10 or 12
  digits) and a SNILS (`112-233-445 95` or eleven digits) are masked as
  `[INN_n]` and `[SNILS_n]` only when their check digits pass, so an order
  id or a date is left alone. A passport, which has no checksum, is masked as
  `[PASSPORT_n]` after `паспорт`, `серия` or `passport` in any common
  spacing, or with no such word only in its printed `45 09 123456` form.
  Buffered Telegram messages are masked the same way on write. (#342)
- A platform admin can see and sign out anyone's sessions from **Access →
  Accounts → Sessions**: each live sign-in with its method and identity
  provider, IP, browser and last use, one at a time or all at once. API keys
  are untouched. The new `DELETE /v1/users/:id/sessions/:sessionId` revokes
  one session (404 for a session id that is not that person's) and is audited
  as `auth.session_revoked` by `admin`; session lists now carry
  `providerName`. (#292)
- MCP agents can work in a page's shared draft (#316). Over the HTTP MCP
  server (`/v1/mcp`), with co-editing on, `knowledge_get_draft` reads the
  draft people are writing in the editor: the body as publishing it would
  write it, the page fields, whether it differs from the published page or
  the page was published another way since, who has it open, and the
  suggestions waiting for a decision. `knowledge_suggest_draft_edit` leaves
  an edit in it, in the editor assistant's shape (`replace`, `insert_after`,
  `insert_before`, `append` or `rewrite` against a quoted anchor), as a
  shared suggestion: everyone with the page open sees it at once, credited to
  the API key for its person, and any editor keeps or discards it. Reading
  never creates a draft; suggesting into a branch without one starts it from
  the head. Viewer and editor on the page respectively, checked on every
  call; a read-only key is not offered the suggestion tool. The stdio MCP
  server does not offer either tool.
- Word (`.docx`) export (#162). A page, a page and its subpages, or a project
  can now be exported as one Word document from the export dialog, through
  `POST /v1/documents/:id/exports` and `POST /v1/projects/:id/exports` with
  `format: "docx"`, and from MCP `knowledge_export`. It needs no Gotenberg, so
  `GET /v1/exports/capabilities` always offers it. Headings are Word heading
  styles, so the navigation pane works. Lists, tables, code, links and the
  export's own images are kept, and images from the web stay links. Callouts
  and expands become shaded blocks. Each page starts on a new sheet, and an
  export of more than one page opens with a title page and contents. Mermaid
  diagrams stay as their source in a code block.
- The server side of real-time co-editing (#80, phase 1), off by default. With
  `COLLAB_ENABLED=true`, a `/v1/collab` WebSocket serves one shared Yjs draft
  per document branch. The draft is seeded once from the branch head, stored in
  PG, and kept in sync across API instances through Redis. A page you may view
  joins read-only, and a page you may edit joins as a writer. No editor connects
  to it yet; that is phase 3. The editor's node specs now live in the new
  buildless package `@knowledge/editor-schema`, so the API builds the same
  schema the editor does.
- A share link can let its readers download what it shows (#161). Tick
  **Let readers download it** when creating the link, or flip **Downloads**
  on an existing one in the page's Share menu; it is off by default and on no
  existing link. The reader then gets a **Download** button that exports the
  link's page, or the page and its subpages when the link includes them, as
  ZIP, HTML or PDF (PDF only where Gotenberg is set up), without signing in.
  The file contains exactly the pages the reader can open through the link,
  never a restricted page and never more than the link's scope. A
  password-protected link asks for its password first. Revoking the link or
  switching downloads off stops even a finished file from downloading at
  once. The job belongs to the link, not to a person: nobody gets an
  inbox notification for it, and it is not in its creator's export history
  (an admin's list on Exports still shows it). The new public routes are
  `POST /v1/public/shares/:token/exports`, `GET …/exports/:id` and
  `GET …/exports/:id/download`. `knowledge_share_page` takes
  `allowDownload`.
- Who may co-edit a draft, checked for as long as they stay (#80, phase 2).
  Joining `/v1/collab` now takes a single-use `kt_` ticket from
  `POST /v1/auth/url-ticket`; a session token or API key is refused there. An
  open connection is re-judged when a page's access changes and every
  `COLLAB_REAUTH_INTERVAL_SECONDS`: a revoked key, an ended session or a
  disabled account is closed, a page restricted away is closed, and an editor
  demoted to viewer (or the reverse) is closed with `access-changed` so the
  client rejoins in its new scope. Every caret's name and avatar is now set by
  the server from the signed-in person, whatever the client sends.
  `GET /v1/collab/capabilities` says whether co-editing is on and which editor
  schema version a peer must match.
- A Google Drive connector. Point it at a folder or a shared drive with a
  service account's JSON key (stored encrypted and write-only, like every
  connector credential); "Act as user" turns on domain-wide delegation. It
  walks the folder as a tree, so with "Keep the external page tree" folders
  become pages and files nest under them, and new connectors are offered
  review mode. Google Docs, Slides and Sheets are exported to DOCX, PPTX and
  CSV and converted by the same parsers as the upload wizard, and so are PDF,
  Word, PowerPoint, HTML, CSV, JSON/YAML and Markdown files. Anything else
  (images, archives, files over 20 MB) is skipped and named on the run, once
  per folder. Images inside a document are not carried over yet, and the page
  says so. With access mirroring on, Drive sharing becomes page restrictions:
  link or whole-domain sharing stays open, and people and groups are matched
  by email. Scheduled syncs read Drive's change feed and fetch only what
  changed. A manual Sync still compares the whole tree. A linked file that was
  trashed, deleted, unshared or moved out of the folder is listed on the run
  with its page kept. Pull only. (#338)
- Several people can now edit one page at once (#80, phase 3), when the server
  runs with `COLLAB_ENABLED=true`. Opening an existing page's editor joins its
  shared draft on the default branch. Typing, the title, tags, category, parent,
  project, relations and the revision message reach everyone on the page as
  they change. Other people show as faces in the header and as named carets in
  their avatar colour. A status dot says whether you are live, offline (edits
  are kept on this device and sync on reconnect), read-only, or stopped and why.
  An "Unpublished changes" chip opens the diff against the published page, and
  publishing works as before. In a shared draft the per-browser working copy is
  off. A copy saved before the page went live is offered once, and applied to
  the draft only on a click. With the flag off, or if the draft cannot be
  joined within 10 s, the editor works on its own exactly as before. Known
  limits until later phases: an assistant suggestion reaches other people as
  plain text (phase 5), and a publish by someone else is not yet shown in the
  draft, so your next publish gets the usual "published since you started"
  error (phase 4).
- Publishing a shared draft now rebases it (#80, phase 4). Publish writes an
  ordinary revision as before, and the draft then counts as published up to
  the moment you pressed it: edits other people make after that stay
  "unpublished" instead of vanishing or being claimed. The revision records
  everyone who wrote in the draft since the last publish, shown as co-author
  faces in the revision history. Opening a page no longer counts as a change.
  When someone publishes the same page another way (MCP, a merge, a connector),
  the editor says so as it happens, the review compares the draft with what
  they published, and you choose **Publish on top** or **Discard draft**.
  Discard resets the draft to the published page for everyone in it, on every
  API instance, and clears each browser's offline copy. The document page and
  an open merge request now show who is editing a branch's draft and whose
  changes are unpublished; on a merge request this is a warning only, never a
  merge gate. `/documents/:id/edit?branch=<name>` edits that branch and its
  draft instead of the default one. New routes: `GET /v1/documents/:id/drafts`
  and `DELETE /v1/documents/:id/drafts/:branchId`. `POST /:id/revisions` takes
  optional `collabDraftId` and `draftSnapshot`. Revisions in API responses now
  carry `coAuthorIds`, an empty list unless they came from a shared draft.
- Knowledge health has an **Agents** tab for workspace admins, showing what
  became of each agent's output (#305). A finding counts as accepted when the
  merge request it was proposed as merged, or when nobody dismissed it within
  14 days. It counts as dismissed when a person dismissed it or closed that
  merge request. An upvoted answer counts as accepted and a downvoted one as
  downvoted. Everything else is pending. Each row can be split by prompt hash
  or by model. With fewer than 20 runs a cell shows a count ("4 of 9") rather
  than a percentage. The same figures are at `GET /v1/agent-outcomes`
  (admin). To make the split possible, every new agent run now records its
  provider, model, a hash of its trusted prompt (instructions, skills,
  styleguide and learnings, never page content) and the learnings it was
  given. Every model call made during a run records the run, and every answer
  vote records the model that wrote the answer, where the server knows it.
  Nothing else changes: outcomes are computed when read and never stored.
- The editor assistant's suggestions are shared in a co-edited page (#80,
  phase 5). Everyone in the draft sees a suggestion as it is written, credited
  to the agent and to the person who asked ("Reviewer · for Ada"), and anyone
  who may edit can keep or discard it. A viewer sees it without the buttons.
  Your undo never walks someone else's suggestion; keeping one makes it your
  edit, which your undo takes back. Publishing is refused while anyone's
  suggestion is undecided. The header says "Reviewer is writing for Ada…"
  while another person's turn streams, and a suggestion whose writer closed
  the tab mid-stream becomes decidable for everyone else. `draft-edit` stream
  frames now carry the turn's `agent` (`key`, `name`).
- A browser that was offline when someone discarded a shared draft no longer
  brings the old page back (#80, phase 6). Each draft now has a generation
  that changes on every reset, and each browser keeps it beside its offline
  copy. A copy from an older generation is refused before it syncs, and the
  editor clears it and reopens the reset page. This holds whether the page is
  reopened later or was open the whole time. Offline edits on a current copy
  still merge in, once. The `/v1/collab` token may now carry that generation
  after the ticket (`collabToken`), and a peer receives it in a stateless
  message after joining. Every draft store now writes a `collab.store` event
  to the ops JSONL stream: duration, draft size, peers, and whether it was
  stored or refused. `make backtest ARGS=--report` summarizes these events,
  and `make collab-load` load-tests running API instances. Real-time co-editing
  is documented in `docs/features/56-realtime-coediting.md`, numbers included.
  It stays off by default (`COLLAB_ENABLED=false`) and is on in the hosted
  deployment, after a dogfood pass on the dev stack.
- Mattermost bots (#343). **Settings → Chat bots → Connect a bot** now offers
  Mattermost beside Telegram and Time: paste a bot account's access token and
  your Mattermost server's address. The bot does everything a Time bot does:
  it answers mentions and direct messages in the question's thread, takes
  👍/👎 and Save, posts a bound channel's notifications, and harvests a thread
  on `capture` (also `remember` or `запомни`) or 📌 (`pushpin`). Commands are
  plain words, because Mattermost's client keeps a leading `/` for its own
  slash commands. Time and Mattermost share one adapter, so a fix to one is a
  fix to both. Buttons need the Mattermost server to reach `API_PUBLIC_URL`,
  and on a private network its `AllowedUntrustedInternalConnections` must list
  that host.
- The graph records when each fact was true (#81, phase 1). Every chunk and
  every frontmatter, inferred and spec relation of a page revision now carries
  the interval its revision was the page's content: from the revision's
  finalize time until the next default-branch revision's. Branch revisions are
  marked as such and never valid. Nothing reads these intervals yet; the "as
  of" queries in the next phases do.
- Read the graph as it stood at a point in time (#81, phase 2). `asOf` takes
  an ISO date, `rev:<revisionId>` (that revision's finalize time) or
  `tag:<name>` on `GET /v1/documents/graph`, `GET /v1/documents/:id/graph`,
  `GET /v1/documents/:id/content` (the revision that was the page's content
  then), the `/v1/entities` list, neighbours and trace routes, and impact
  analysis. A fact a page has since dropped shows as of before the change;
  one added later does not. `knownAt` (an ISO date) answers with what was
  believed then, so a relation retracted since still shows. Each response
  echoes `resolvedAsOf`. A malformed value is a 400, an unknown tag or another
  workspace's revision a 404. Page permissions apply exactly as they do now.
- A Telegram group that keeps its messages can be harvested automatically
  (#340). A workspace admin turns on *Harvest quiet threads automatically* on
  the group in Settings → Chat bots, and the bot tells the group first; if it
  cannot, the switch stays off. From then on, a thread (the group, or one
  forum topic) is harvested once it has `HARVEST_AUTO_MIN_MESSAGES` new kept
  messages and nothing new for `HARVEST_AUTO_QUIET_MINUTES`, and again only
  after something new is said in it. Nothing said before the switch went on
  is read. The captures are proposed in the name of the admin who turned it
  on, whose admin role is checked again on every harvest. Nothing is posted
  in the group: that admin gets an inbox notification with the counts, and
  the captures wait in the Captures inbox. Each harvest is one `harvest`
  model call, counted against that admin's `HARVEST_RATE_PER_HOUR`, and at
  most `HARVEST_AUTO_MAX_PER_TICK` run per group per minute. Turning keeping
  off turns this off too. Off by default on every group.
- Release tags (#81): named instants such as `v2.3` that `asOf=tag:<name>`
  resolves to. `GET /v1/release-tags` (viewer), `POST /v1/release-tags`
  (editor; a duplicate name is a 409) and `DELETE /v1/release-tags/:id`
  (admin). A tag can belong to one project or the whole workspace.
  `GET /v1/graph/timeline` returns the tags and per-day counts of facts that
  started and stopped being true in a window, for the time slider to come.
- MCP: `knowledge_get_workspace_graph`, `knowledge_find_relations`,
  `knowledge_impact_analysis` and `knowledge_trace_relation` take `asOf` and
  `knownAt`. `knowledge_get_historical_context` takes `asOf` instead of
  `atRevisionId` for the workspace's view of an entity then. New tools:
  `knowledge_list_release_tags` and `knowledge_create_release_tag` (a write,
  hidden from read-only keys).
- Search as of a point in time (#81, phase 3). `POST /v1/search` and MCP
  `knowledge_search` take `asOf` (and `knownAt`, for the graph expansion):
  the vector leg, the BM25 leg, the tag filter and the graph expansion all
  answer from the text and relations each page held then, so a search as of
  release `v1` finds the paragraph v1 said and a search of now finds only
  today's. Each result of an `asOf` search carries `validFrom` and `validTo`;
  a `validTo` means that text has since been superseded. Filters, page
  permissions and the trust re-rank work as they do now.
- Time in the app (#81, phase 4):
  - **Graph timeline.** The pages graph and the maximized page graph have a
    timeline along their bottom edge. Drag it, use the arrow keys (a day),
    Page Up/Down (a week) or Home/End, or click a release tag's tick, and the
    graph redraws as the knowledge base stood then. Faint bars over the
    timeline show how much changed when.
  - **Changes since.** In the graph panel's new **Time** section, "Show changes
    since" overlays the difference against now: relations that have since
    ended draw as a dotted trace, and relations added since draw in green.
  - **Links.** `?asOf=` on `/documents` opens the graph at that point.
  - **Search.** The search filters have an **As of** section (a date or a
    release tag). A result whose text has since been replaced carries a dated
    "Superseded" badge and opens the page as it read then.
  - **Pages.** A page opened with `?asOf=` is read-only, with a note naming
    the date, the tag and the revision.
  - **Releases.** Settings → Releases lists the release tags. Editors add one
    for now or any instant, for the whole workspace or one project; admins
    delete them.
- Contradictions between pages (#81, phase 5, API and MCP). A new
  background agent, the **arbiter**, compares passages from different pages
  that are close in meaning (pages that share an entity are held to a lower
  bar), asks the model whether they disagree, and keeps the answer only when
  both quoted sentences really are in the passages. Each one becomes a
  conflict: `GET /v1/conflicts` and `GET /v1/conflicts/:id` (viewer; only
  conflicts whose pages you may both open), `POST …/resolve` and
  `POST …/dismiss` (editor, with an optional note), and `POST …/propose`
  (editor), which opens one merge request fixing the first page — a second
  press is a 409 `already-proposed`. A dismissed conflict stays dismissed when
  found again; when one side's page changes, its open conflicts become
  `superseded`, and reopen if the new text still disagrees. Run the arbiter
  from Settings → AI, on a schedule, or on `page.indexed` to check every page
  as it is indexed; nothing runs until one of these is set up. Each judgement
  is one model call, recorded as `contradiction` in AI usage. MCP:
  `knowledge_list_conflicts` and `knowledge_resolve_conflict` (a write,
  hidden from read-only keys).
- Contradictions in the app (#81, phase 5). A page with an open
  contradiction gets a **Contradictions** section in its side rail: what this
  page says, what the other page says, why they disagree, and, for editors,
  **Propose fix** (opens a merge request), **Resolve** and **Not a
  contradiction**. **Contradictions** in the sidebar lists them all by status,
  each with the two passages side by side; with none open, it says how to run
  the arbiter.
- Pages a pull request makes wrong are contradictions too (#81, phase 6).
  When the drift check (feature 35) finds a page the change makes untrue, it
  records a page-vs-code conflict: the page's sentence, beside the pull
  request, the commit it judged and the files it touches. Every push to the
  same pull request updates that one conflict rather than adding another.
  Both kinds of conflict now close themselves: merging the merge request a
  fix was proposed as, from the conflict, the agent runs panel or the drift
  check's own proposal, marks it resolved.
- Broad questions across the whole knowledge base (#81, phase 7), off by
  default. With `COMMUNITY_SUMMARIES_ENABLED=true`, a new background agent,
  the **atlas**, groups pages that name the same things into communities and
  summarises what each one covers. Run it from Settings → AI or on a
  schedule; a run where the graph has not changed rebuilds nothing. The
  Ask assistant gains a `global_overview` tool that finds the communities
  closest to a broad question ("what are our main risks?") and cites their
  pages; MCP gains `knowledge_global_overview`, and
  `GET /v1/graph/communities` lists them. A community with a page you may
  not open is withheld whole. The pages graph can colour pages by community
  (**Colour pages by community** in its Filters). Each summary is one model
  call, recorded as `community` in AI usage.
- Usage analytics starts recording (#79, phase 1). Every search, MCP tool
  call, and page read by an API key, MCP, the in-app assistant, a chat bot
  or an agent now leaves a row in PostgreSQL (`search_queries`,
  `mcp_tool_calls`, `page_views`). Each row is filed under the channel it
  came from, so later phases can split human, assisted and agent traffic.
  `POST /v1/search` and MCP `knowledge_search` return a `searchId`. A
  person reading in the browser is not counted yet; that is phase 2's page
  beacon. Readers are never stored by name: each one is an HMAC that is
  per workspace, so readers can be counted but not identified. A request
  sent with `DNT: 1` or `Sec-GPC: 1` is counted with no reader at all. A
  failed analytics write never fails the request it describes. There is
  no dashboard yet (phases 3–4), and nothing is backfilled, because no
  earlier source recorded reads or who searched.
- Page reads in the browser are counted (#79, phase 2). Opening a page in the
  app records one view, and the time spent actually reading it is added to
  that view: the time only grows while the tab is visible and the reader
  has scrolled, typed or moved the pointer in the last 30 seconds. It is
  reported every 15 seconds and once more when the tab is hidden or closed,
  and capped at 30 minutes per view. Opening a search result records which
  search it came from and its rank, which lets later phases measure
  click-through; the `sid`/`rank` parameters leave the address bar once the
  page loads. A browser that sends Do Not Track or Global Privacy Control is
  counted with no reader. Only a page the reader may open is counted. The
  beacon is a same-origin request using the app's own credential: no
  cookie, nothing third-party. New routes: `POST /v1/documents/:id/views`
  and `POST /v1/analytics/views/:viewId/heartbeat`, both `204`.
- See how pages are read (#79, phase 3). A page's rail has an **Insights**
  widget: views over the last 30 days split into people, the assistant
  (in-app or a chat bot) and agents (API keys, MCP, background runs), plus
  unique readers, median read time and when someone last opened it in the
  app. Anyone who may open the page sees it; it shows counts, never who.
  For editors, a project's overview page gains a **Reading** section: the
  same numbers over 7, 30 or 90 days, the most read pages, pages nobody has
  opened in the app, and dead pages, meaning pages older than 90 days that
  nobody opened and no search returned in that time. Knowledge health gains
  a **Last read** column and two filters, **Unread** and **Dead**, which list
  the same pages. Neither filter lists anything until reads have been
  counted for the whole 90 days, so a fresh install does not call every page
  dead. Every count is limited to pages the viewer may open. New routes:
  `GET /v1/documents/:id/insights` (viewer) and
  `GET /v1/projects/:id/analytics?days=&traffic=` (editor).
- A workspace **Analytics** page for admins (#79, phase 4), at `/analytics`
  beside Knowledge health. **Overview** shows views, readers, median read
  time, searches, the share that found nothing, click-through, assistant
  questions and MCP calls, plus views per day split into people, assistant
  and agents. **Pages** lists the most read, never opened and dead pages
  across the workspace. **Search** lists top queries, queries that found
  nothing, and searches whose results nobody opened. **Agents** lists MCP
  calls by tool, what each API key did (by name and prefix only), the
  assistant's questions per day and model calls by purpose. Every view takes
  a range (7, 30 or 90 days), and every tab except Agents also takes a
  traffic filter (all, people, assistant, agents). A reader who repeats one
  query within 10 seconds, such as by toggling a filter, counts as one
  search. Click-through counts only searches in the app that found
  something. Every list has **Export CSV**: the whole table, up to 5,000
  rows, in RFC 4180 CSV. A cell that starts with `=`, `+`, `-` or `@` gets a
  leading `'` so a spreadsheet cannot run it as a formula. Each export is
  written to the audit log as `analytics.export`. The **Settings** tab turns
  recording off for the workspace or shortens how long rows are kept. It
  shows each value as requested, the deployment ceiling, and the value that
  applies. New admin routes: `GET /v1/analytics/overview`, `/pages`,
  `/search`, `/agents`, `/export.csv?report=`, and `GET`/`PUT
  /v1/analytics/settings`.
- Analytics rows are now deleted when they age out (#79, phase 4). The worker
  sweeps every hour and deletes page views, searches and MCP calls older than
  the workspace's retention (default 180 days). After 90 days a search loses
  its text but keeps its hash, so it still groups with the same query.
- Two MCP tools for usage analytics (#79, phase 5).
  `knowledge_get_page_insights` returns how often a page was read over the
  last 30 days, split into people, assistant and agents. Anyone who may open
  the page can call it. `knowledge_list_search_gaps` returns the searches
  that found nothing and the app searches whose results nobody opened: the
  pages worth writing next. It is for workspace admins, so a read-only key
  sees it listed but is refused, as on `GET /v1/analytics/search`. The query
  text in its answer is what readers typed, so it comes back wrapped as
  untrusted data. The feature is documented in
  `docs/features/58-usage-analytics.md`.
- Ask a Time bot to remember a thread (#82, phase 2). An editor of the
  workspace with a linked account sends `capture` (or `remember`, or
  `запомни`) as a reply inside a thread, mentioning the bot in a channel. The
  bot reads the thread up to that message, masks emails, phone numbers, card
  numbers and credential-shaped tokens, and has the new `harvester` agent
  propose what the thread settled: decisions, gotchas, conventions, how-tos,
  glossary terms and answered questions. Each proposal becomes a capture in
  the asker's name, with the usual dedupe and review, and shows where it came
  from with a link to the thread. A glossary term is kept only if the thread
  contains it word for word, and an answer only if it cites a page found by
  searching the knowledge base as the asker. The bot replies with counts and
  a link to the Captures inbox, never a title. A viewer or an unlinked person
  is refused before the thread is read. Each harvest is booked as AI usage
  `harvest` against the asker, and one person may start
  `HARVEST_RATE_PER_HOUR` of them an hour.
- Ask a Telegram bot to remember a thread (#82, phase 3). In a group, an
  editor with a linked account sends `/capture` as a reply to the first
  message of the thread. In a private chat, they forward the bot the
  messages and then send `/capture`; the bot holds forwards for a couple of
  minutes instead of answering them. A workspace admin can let a group keep
  its messages for harvesting (*Keep messages for /capture* on the group in
  Settings → Chat bots). The bot first posts a notice in the group, and
  keeps nothing if it cannot. Kept messages are masked before they are
  stored, are never searchable, and are deleted after `CHAT_LISTEN_TTL_DAYS`,
  when keeping is turned off or the group unbound, and per person on
  `/forget`. Without keeping, `/capture` reads only the message it replies
  to, and the reply says so; it also says when that message is older than
  what is kept. `/capture` and `/forget` are in the Telegram `/help`.
- React to a message to have the bot remember its thread (#82, phase 4).
  In Time, 📌 on any message of a thread harvests the whole thread. In
  Telegram, which has no 📌 reaction, ✍ on a kept message works like
  `/capture` sent as a reply to it. Telegram delivers reactions only to a bot
  that is a group admin, and the reaction does not include the message, so ✍
  needs keeping turned on. Only a linked editor's reaction does anything;
  the bot says nothing to anyone else, so a busy channel's ordinary 📌 never
  gets a reply. The bot answers under the message with counts and an inbox
  link, the same as for `capture`.

### Changed

- 💾 Save on a chat bot answer now goes through agent memory (#82). *As a
  page draft* saves the answer as an `answer` capture citing the pages the
  answer cited, the same as "Save to knowledge base" in the assistant pane.
  It no longer has a model rewrite the conversation into a page. *As a
  glossary term* proposes the term into the Captures inbox instead of creating
  it switched off. Both get the usual capture dedupe, rate limits and secret
  scan. An answer that cites no page can no longer be saved, and the bot says
  so. A second press reports the duplicate instead of "already saved". The
  Captures inbox and a merge request's provenance strip show where a chat
  capture came from: the platform, the chat and the time span. A new page's
  frontmatter records it under `sources:`. Captures written over MCP or REST
  may now report `session.client: 'chat'`.
- The pages landing loads faster on a cold visit. The server now renders
  the rail's project roster, the active project's name and the first level of
  the page tree, so they no longer wait for the app's JavaScript.
  `/v1/projects`, `/v1/workspaces` and `/v1/documents/tree` are requested once
  per page load instead of once per component that wanted them. The shell
  preloads 50 scripts instead of 103: the search sheet, the create dialog and
  the page row's Move, Export and Access dialogs load when first opened. The
  heading fonts no longer block the first paint, and the graph spreads its
  opening layout over frames instead of one long task. (#279)
- Deleting a relation, re-posting an explicit one or curating over an inferred
  one no longer erases the old edge (#81). It is retracted: gone from every
  current view as before, but listed in `GET /v1/documents/:id/facts/timeline`
  with `status: 'retracted'`, `retractedAt` and `retractedBy` (`user:<id>`). A
  re-index of the same revision that no longer infers a fact retracts it the
  same way, with `retractedBy: 'extractor'`. Deleting a page still erases its
  graph.

### Fixed

- An SSO sign-in link that is reused, expired or unknown now shows up in
  Settings → Security → Audit as a failed sign-in, like every other refused
  SSO attempt, and the browser lands on the sign-in page with the localized
  reason instead of a bare "back to login" card. (#291)
- Initials on generated avatars and on project and workspace monograms are
  readable on every colour (#355). Yellow, green and cyan tiles put white
  letters at as little as 2.3:1 contrast, below the 4.5:1 WCAG asks for. Those
  tiles are now a deeper shade of the same hue, so a person, project or
  workspace keeps its colour; tiles that were already dark enough, such as blues
  and purples, are unchanged.
- BM25 search and indexing recover by themselves once OpenSearch is reachable
  again (#330). A worker or API that first reached OpenSearch while it was
  down or still starting (connection refused, DNS, a dropped connection) kept
  failing every BM25 call with `fetch failed` until it was restarted: the
  worker wrote nothing to the keyword index and the stale sweep's backlog only
  grew, and search stayed `degraded: ['fulltext']`. The next call now retries
  the setup, so after an OpenSearch restart the sweep re-mirrors the stale
  revisions and search logs its recovery.
- On a phone, screen readers now name the buttons that show only an icon
  (#354). Below the `sm` width, the Graph / Tree / List tabs, Upload, New page,
  Show archived and Filters on `/documents` hid their label from assistive
  technology along with the screen, so they were announced as "tab, selected"
  or "link". The same applied to New chat in the assistant, the editor's AI
  button, Ask on a published site, the filter rail toggle on merge requests,
  and Ask the architect and Configure in the workflow builder. The label is
  still hidden on screen but is now read aloud. Nothing looks different.
- The editor no longer opens a page it failed to load (#314). If any request
  for an existing page failed (the connection dropped mid-load, a 5xx, a
  timeout), the editor used to open with an empty title and body and Publish
  enabled, and publishing finalized an empty revision over the page; text
  typed into it was kept as a working copy. It now shows the error with a
  Retry button and a link to the page, Publish stays unavailable and nothing
  is stored on the device until the page loads. Retry joins the shared draft
  when co-editing is on.
- Changing the role of a member whose membership source is missing or not one
  of `manual`, `jit`, `group`, `scim` no longer fails with 409 "managed by
  single sign-on (manual)" (#295). The members list already shows such a row
  as manual, and editing it now treats it as manual too. Every row the
  current release writes has a known source, so this only affects data
  written some other way.
- Returning to the app no longer re-downloads its scripts and styles (#277).
  The content-hashed files under `/assets/` were sent with no `Cache-Control`,
  so the edge's 4-hour default applied; they are now cached for a year as
  `immutable`. The HTML shells and the favicon are revalidated on every use,
  and a member's rendered page is `private, no-cache`.
- An MCP tool call refused with structured reasons now carries them (#300).
  Under enforced SSO, an agent's tool error said only "requires single
  sign-on": it never got `reason: 'ssoRequired'` or the providers to sign in
  through, which REST puts in `details`. A refused tool call now returns the
  message as before, followed by a second text block
  `{ statusCode, message, details }` with the same `details` REST sends. This
  applies to every refusal that carries extras, such as a page permission's
  `canRequestAccess`; errors without extras are unchanged.
- `/robots.txt` on the app's own host returned the app's HTML page (#277). It
  is now plain text that keeps crawlers out of the member app and lets them
  into path-mode published sites under `/pub/`. A site's own `robots.txt` is
  unchanged.
- The app no longer throws away its server-rendered page on load (#278). Two
  things made the first client render differ from the server's, so the browser
  logged a hydration mismatch and rebuilt the page: a visitor who never picked a
  language got the page in their browser's language (Russian, say) and the app
  then started in English; and with the page tree open in the sidebar,
  `/documents` drew a loading skeleton on the server but the tree in the
  browser. The app now starts in the language the server rendered, renews the
  language cookie from your saved choice, and shows the sidebar tree one frame
  after load.
- Voice control can now operate the workspace switcher, the sidebar's back
  button, the account menu and the notification bell by what they show (#280).
  Each one announced a generic name ("Workspaces", "Account menu",
  "Notifications") instead of the workspace, project or person on screen, or
  the unread count, so saying "click RTech OMS" did nothing. Screen readers now
  hear the visible text first, then what the control is for. The "more ways to
  start a page" chevron next to `+` in the sidebar is now 24 px wide instead of
  14 px, so it is easier to hit.
- Asking AI to clean up or merge a staged connector page while the `drafter`
  agent is turned off now says so, in English or Russian (#294). The refusal
  used to show the raw key `error.ai.disabled`. CI now fails when an API
  message exists in only one language, when its `{placeholders}` differ
  between them, or when the code names a message key neither one has.
- A page's Insights widget now counts the visit you are making (#336). It was
  read before the page recorded your view and never read again, so it showed
  one view fewer than the API held, and the same was true of unique readers
  and the last time a person opened the page. The widget is now read again
  once your view is recorded. Read time still catches up on the next load.

### Operations

- After deploying #277, purge the Cloudflare cache once: asset URLs already
  cached at the edge keep the 4-hour lifetime they were stored with until then.

- The web app's images and file previews now depend on the browser calling the
  API on the web's own origin under `/api`, which the bundled Caddy config and
  the Vite dev proxy both do. A deployment that points `VITE_API_URL` at a
  different origin will see every attachment and avatar fail with 401, because
  the browser does not send the `kn_token` cookie there. (#102)
- Migration `20261119100000_share_link_download` adds
  `share_links.allow_download` (default `false`) and a nullable
  `export_jobs.share_link_id` with an index. It is additive and reversible
  under expand/contract: the previous release ignores both columns, so after
  a rollback a reader's files show up in the link creator's Exports until
  the export sweeper removes them. Two env vars, both with defaults:
  `PUBLIC_EXPORTS_PER_HOUR_PER_IP` (`5` per address and link) and
  `PUBLIC_EXPORTS_PER_HOUR_PER_LINK` (`30` per link). Both limits fail
  closed: with Redis down, no reader can start an export. (#161)
- Migration `20261118100000_chat_listening_buffer` adds
  `chat_channel_bindings.listening` (default `false`) and the
  `chat_buffered_messages` table. It is additive and survives a code
  rollback; after a final rollback, drop `chat_buffered_messages` by hand,
  since nothing else deletes its rows. Two env vars, both with defaults:
  `HARVEST_FORWARD_WINDOW_SEC` (`120`) and `CHAT_LISTEN_TTL_DAYS` (`7`).
  Keeping messages needs the bot's privacy mode off in @BotFather
  (`/setprivacy`), or the bot made a group admin.
- Telegram bots receive ✍ only after their webhook is registered again,
  now that it also asks for `message_reaction`. After deploying, press
  **Test** on each Telegram bot in Settings → Chat bots, which registers the
  webhook again. Time needs nothing. No migration, no new env var.
- Harvest adds three env vars, each with a default, so nothing needs setting:
  `HARVEST_ENABLED` (`true`; `false` answers `capture` with a notice),
  `HARVEST_MAX_MESSAGES` (`200`: the root and the newest replies) and
  `HARVEST_RATE_PER_HOUR` (`10` per person). The `harvester` agent appears
  under Settings → AI agents and can be switched off there. No migration.
- Migration `20261120100000_chat_auto_harvest` adds the nullable
  `chat_channel_bindings.auto_harvest_by` and `auto_harvest_at` columns and
  the `chat_harvest_marks` table (#340). It is additive and survives a code
  rollback; after a final rollback, drop the table and the two columns by
  hand. Four env vars, each with a default, so nothing needs setting:
  `HARVEST_AUTO_ENABLED` (`true`; `false` stops every automatic harvest
  whatever a group's switch says, and the settings page says so),
  `HARVEST_AUTO_MIN_MESSAGES` (`8`), `HARVEST_AUTO_QUIET_MINUTES` (`60`) and
  `HARVEST_AUTO_MAX_PER_TICK` (`1` harvest per group per minute; `0` stops
  the sweeper). The sweeper runs in the API, beside the chat answer sweeper,
  only while `CHAT_ENABLED` and `HARVEST_ENABLED` are on.
- Migration `20261117100000_chat_captures_into_agent_memory` adds a nullable
  `knowledge_captures.origin` column. It copies every `chat_captures` row into
  `knowledge_captures` under the same id, with its status, and then **drops
  `chat_captures`**. A row that has no project anywhere (page and term both
  deleted, saved in a DM, workspace without projects) is not copied. **Not
  reversible:** after a rollback to v0.27.x, 💾 Save in a chat fails until
  this release is rolled forward again. Everything else in the previous
  release still runs. `CHAT_CAPTURE_TIMEOUT_SECONDS` is no longer read, and
  can be removed from the `production` environment.
- Migration `20261122100000_connector_change_cursor` adds the nullable
  `connectors.change_cursor` and `connector_runs.change_cursor` (the Google
  Drive change feed's bookmark). It is additive and survives a code rollback.
  The Drive connector needs outbound HTTPS to `oauth2.googleapis.com`,
  `www.googleapis.com` and, for group mirroring, `admin.googleapis.com`. (#338)
- Migration `20261116100000_usage_analytics` adds the `page_views`,
  `search_queries` and `mcp_tool_calls` tables and two nullable
  `workspace_settings` columns (`analytics_enabled`,
  `analytics_retention_days`). It is additive and survives a code
  rollback. New env vars, both with defaults: `ANALYTICS_ENABLED` (`true`;
  `false` records nothing) and `ANALYTICS_READER_SECRET` (empty). When the
  secret is empty, the reader key is derived from `SETTINGS_ENCRYPTION_KEY`,
  which production sets. No retention runs yet (phase 4), so the tables grow
  until then.
- Migration `20261121100000_learning_ledger` adds nullable attribution
  columns: `agent_runs.provider_id`, `model`, `prompt_hash` and
  `learning_ids`; `ai_usage.agent_key` and `agent_run_id`;
  `answer_feedback.provider_id` and `model`. There is no backfill, so rows
  from before it read as unattributed. It is additive, so rolling back to the
  previous image is safe. No new env vars. (#305)
- New env var with a default: `ANALYTICS_READ_TIME_CAP_MS` (`1800000`), the
  most active read time one web view can record. No migration in #79
  phase 2.
- New env var with a default: `ANALYTICS_DEAD_PAGE_DAYS` (`90`), the window
  behind the unread and dead page lists. No migration in #79 phase 3.
- New env vars with defaults (#79 phase 4): `ANALYTICS_RETENTION_DAYS`
  (`180`), a ceiling on how long analytics rows are kept, which a workspace
  may only shorten; and `ANALYTICS_QUERY_TEXT_DAYS` (`90`), after which a
  recorded search keeps its hash and loses its text. No migration. The
  worker's first sweep runs at boot, so the first deploy deletes any
  analytics rows already older than 180 days. Nothing that old exists yet,
  because recording began in phase 1.
- New env vars for community summaries, both with defaults:
  `COMMUNITY_SUMMARIES_ENABLED` (`false`) and `COMMUNITY_MAX_PER_RUN`
  (`30`). Summaries are stored in ArcadeDB as `Community` vertices (created
  on worker boot); no migration.
- Migration `20261115100000_knowledge_conflicts` adds the
  `knowledge_conflicts` table and nothing else; it survives a code rollback.
  New env vars, all with defaults: `CONTRADICTION_MIN_SIMILARITY` (`0.82`),
  `CONTRADICTION_MIN_CONFIDENCE` (`0.7`) and `CONTRADICTION_MAX_PAIRS_PER_RUN`
  (`20`). The arbiter does not run on `EMBEDDINGS_PROVIDER=stub`.
- With OpenSearch (`FULLTEXT_PROVIDER=opensearch`), the index gains
  `validFrom`, `validTo` and `lineage` fields on its first write after the
  deploy; no reindex is needed. `make graph-live-backfill` now stamps the
  BM25 mirror as well as the graph, so run it after #81 phase 3 if it was
  already run for phase 1. Until it runs, an `asOf` search's BM25 leg finds
  no history for older pages (the vector leg is unaffected once the graph is
  stamped).
- Migration `20261114100000_release_tags` adds the `release_tags` table and
  nothing else. It survives a code rollback, because the previous image never
  reads it.
- Run `make graph-live-backfill` once after deploying #81 phase 1. It now also
  stamps valid time on the chunks and relations written before this release;
  without it, the "as of" reads of later phases find no history for those
  pages. It is idempotent and safe beside a running worker, and current views
  do not depend on it. Note the target runs `nest build` first, so on a dev
  machine it restarts a running `make dev`. No migration.
- Migration `20261112100000_collab_drafts` adds the `collab_drafts` table and
  nothing else. It survives a code rollback, because the previous image never
  reads it. New env vars, all with defaults and none required:
  `COLLAB_ENABLED` (`false`), `COLLAB_STORE_DEBOUNCE_MS` (`2000`),
  `COLLAB_STORE_MAX_DEBOUNCE_MS` (`10000`), `COLLAB_MAX_DOC_BYTES` (8 MiB) and
  `COLLAB_REAUTH_INTERVAL_SECONDS` (`300`). With the flag off, no Hocuspocus
  instance or Redis connection is created, and the socket closes with 4503.
- Migration `20261113100000_collab_publish` renames
  `collab_drafts.published_state_vector` to `published_snapshot` (the column
  was never written), adds `collab_drafts.snapshot`, and adds three nullable
  columns to `document_revisions`: `collab_draft_id`, `collab_snapshot` and
  `co_author_ids`. There is no backfill. It survives a rollback to v0.27.0,
  which reads none of these. New env vars, all with defaults:
  `COLLAB_CHECKPOINT_INTERVAL_MINUTES` (`15`), `COLLAB_CHECKPOINT_KEEP` (`20`)
  and `COLLAB_DRAFT_RETENTION_DAYS` (`30`). With the flag on, a draft edited
  since its last checkpoint is copied to MinIO at
  `workspaces/{ws}/documents/{doc}/drafts/{branch}/checkpoint.ydoc` at most
  every interval, and the newest `KEEP` versions are kept. A draft with
  nothing unpublished and untouched for the retention period is dropped and
  reseeds the next time it is opened.
- The hosted deployment turns co-editing on: `.env.production.example` now
  lists `COLLAB_ENABLED=true`, so the deploy refuses to run until the GitHub
  `production` environment carries it
  (`gh variable set COLLAB_ENABLED --env production --body true`). The socket
  is `/api/v1/collab` on the existing `/api` route, so Caddy and the edge
  Worker need no change. To turn it off again, set the variable to `false` and
  redeploy: open editors fall back to single-user, and drafts stay in
  `collab_drafts` until they are reopened or expire.

- Production embeds with bge-m3 (1024-d) served by Ollama.app on the host,
  not the hash stub (#257). The `production` environment carries
  `EMBEDDINGS_PROVIDER=openai-compatible`,
  `EMBEDDINGS_BASE_URL=http://host.docker.internal:11434/v1`,
  `EMBEDDINGS_MODEL=bge-m3` and `EMBEDDINGS_DIM=1024`. These are applied
  already (a rerun of the v0.27.0 deploy on 2026-10-18), and every branch head
  is reindexed. `.env.production.example` now requires the two new keys, so
  a deploy fails early if they are missing from the environment. The host needs
  `bge-m3` pulled and the `dev.hrustalq.ollama-keepalive` LaunchAgent, which
  keeps the model loaded. **Rollback:** set `EMBEDDINGS_PROVIDER=stub` and
  `EMBEDDINGS_DIM=768` and redeploy. The sweeper's drift check then reindexes
  every head back, with no code change. Until a page is reindexed, its chunks
  drop out of the vector leg, though BM25 still finds it.

## [0.27.0] — 2026-10-18

### Added

- A document can now be an OpenAPI or AsyncAPI spec rather than a markdown
  page. Pass `kind: 'openapi' | 'asyncapi'` to `POST /v1/documents` with
  `content.format` `yaml` or `json`. OpenAPI 3.0, 3.1 and Swagger 2.0
  (upgraded on read) are accepted, and so are AsyncAPI 2.x and 3.x. A spec
  that does not validate is refused with a 422 (`code: UNPROCESSABLE`, the
  validator's messages in `details.issues`), at create or at finalize. A
  remote `$ref` is refused, never fetched. Once indexed, a spec is
  searchable by its operations, summaries, parameters and schemas. The graph
  holds one `DESCRIBES` edge per operation (`op:<slug>:<METHOD> <path>`) or
  channel (`channel:<slug>:<address>`). Path parameters are folded, so
  `/users/{id}` and `/users/{userId}` are one operation. A page that names
  the same key in its frontmatter `relations:` links to the same entity. The
  slug is fixed when the spec first indexes, so renaming `info.title` does
  not break those links; only `x-knowledge-key` changes it. This is the
  first phase of the API reference: the reader, try-it, the merge-request
  diff and repo sync come in later releases. (#78)
- Reading API specs over the API and MCP. `GET /v1/api-specs` lists the spec
  documents you can open, with each head's operation count.
  `GET /v1/api-specs/:id` returns one revision parsed (OpenAPI upgraded to
  3.1, internal `$ref`s kept), and `GET /v1/api-specs/:id/operations`
  returns its operations. `GET /v1/api-operations?q=` searches operations
  across every spec, by method and path, summary or operationId. Agents get
  `knowledge_list_api_operations` and `knowledge_get_api_operation`. The
  latter returns an operation's parameters, body and responses as markdown,
  plus the pages that link to it, such as a use case that `IMPLEMENTS` it.
  Both work with read-only keys. `knowledge_create_revision` now writes a
  spec document's whole YAML or JSON body; name it with `syntax`. The
  document detail response gains `kind`. (#78)
- A spec document now reads as an API reference rather than a page. Every
  operation or channel gets its own card, grouped under its tag. A card shows
  the parameters, request body, responses or messages, with schemas as a
  collapsible field tree that marks a recursive type instead of looping. It
  also shows examples, deprecation, and the pages that link the operation,
  each with its fact class. When no page links it yet, the card shows the
  frontmatter that would. An **Operations** card in the page rail lists them
  all. Clicking a row scrolls to that operation, and the row being read stays
  highlighted as you scroll. `?op=<entityKey>` lands on that operation.
  Specs are written in a text editor: "API spec" in the new-page menu, or
  Edit on a spec. The editor loads a `.yaml` / `.json` file, publishes a
  revision, and lists the validator's messages when the spec is refused.
  `GET /v1/api-specs/:id` now reports the spec version as written (`3.0.3`)
  rather than the upgraded one. (#78)
- Code samples and a try-it console on every HTTP operation of a spec. Each
  operation shows its request as cURL, JavaScript `fetch`, Python `requests`
  and Go `net/http`. Where the spec has `x-codeSamples` for a language, the
  author's sample is shown instead and labelled as theirs. Credentials appear
  as environment variables (`$TOKEN`, `process.env.TOKEN`…), never as values.
  "Try it" opens a console with the server, parameters, credentials and body,
  prefilled from the spec's examples, and the sample follows what you type.
  Requests go from your browser by default; when the API refuses CORS, the
  console says so. Credentials stay in the browser tab's `sessionStorage`.
  The same samples are available from
  `GET /v1/api-specs/:id/samples?entityKey=&lang=` and from
  `knowledge_get_api_operation` with `lang`. (#78)
- A try-it proxy for APIs that refuse browser requests, at
  `POST /v1/api-specs/:id/try`. It is off unless the deployment allows it, and
  workspace admins set the mode under Settings → API reference
  (`GET`/`PATCH /v1/workspaces/:id/api-settings`). The page shows both the
  mode asked for and the mode in force. The proxy sends only to a server named
  by the spec revision being read, and only for an operation that revision
  defines. `allowlist` reaches only hosts the workspace's source policies
  allow, `open` any public host they do not block. Private addresses are
  refused, including a name that resolves to one at connect time. Redirects
  are returned, not followed. `Set-Cookie` never comes back, and `Cookie` /
  `Host` are never forwarded. Each request needs the editor role and counts
  against a per-person rate limit. The audit log records method, host and
  path template, never headers or bodies. It is not an MCP tool. (#78)
- Pages can now link to the operations of an API spec. In page settings,
  **Link API operation** searches every spec you can open and adds the
  operation as an `IMPLEMENTS` relation, and the row shows which endpoint
  and spec the key resolves to. An API block can be linked to a spec
  operation with **Link to spec**. A linked block takes its method and path
  from the spec, keeps only your summary, and shows the parameters, body and
  responses live from the spec's head. If the operation leaves the spec, the
  block says so instead of going stale. The page then `IMPLEMENTS` the
  operation, so it appears in the operation's linked pages.
  `GET /v1/api-operations` takes `entityKey` to resolve one key in any
  spelling. In the graph, operations and channels are drawn as squares and
  open their card in the spec. In workflows, a fan-out step whose source
  page links operations (or which runs against a spec) can tag each item
  with one of them. The endpoint draft under that item gets the spec's text
  for the operation and declares `DESCRIBES` on it. (#78)

- Merge requests on an API spec now say what the change does to the API.
  An **API changes** tab lists every changed operation, grouped by endpoint,
  breaking changes first. Breaking means a client of the old spec can fail
  against the new one: an operation or channel removed, a required parameter
  or request field added, a parameter's type changed, an allowed value or a
  response status or field removed, or authentication now required. Each
  operation lists the pages that link it, so the docs a breaking change makes
  wrong are one click away. Operations are matched by method and path, so
  reordering parameters or renaming a path parameter is no change. The same
  classified diff is in the revision compare, in `GET /v1/documents/:id/compare`
  (as `api`), at `GET /v1/api-specs/:id/diff?from=&to=`, and for agents as
  `knowledge_diff_api_spec`. Workspace admins choose what a breaking change
  does under Settings → API reference: `warn` (the default) names it in the
  merge widget, `block` refuses the merge with a 409 (`reason: breaking-api`,
  `breakingCount`) until an admin acknowledges it, and `off` does neither. An
  acknowledgement covers the branch as it was: a later push needs a new one.
  `GET /v1/merge-requests/:id/api-changes` returns the diff, the linked pages
  and whether a merge would be refused. (#78)
- Markdown / Git and Codebase connectors can sync API spec files. List them
  under **API specs**, comma-separated globs matched from the repository root
  (`openapi.yaml, specs/**/*.json`); a file under them that declares
  `openapi`, `swagger` or `asyncapi` becomes a spec document, and one that
  does not (a schema fragment) is skipped. A spec split across files is
  bundled into one document: relative `$ref`s to files in the same snapshot
  are inlined, and a remote `$ref` is reported on the run and never fetched.
  The first sync creates the spec page; after that, **a changed spec always
  arrives as a merge request**, in every sync mode, so the API changes tab and
  the breaking-change gate see it before readers do. A newer change to the
  same file replaces the open merge request. The connection test lists the
  spec files it finds, and the setup dialog offers to add them. Specs are
  never pushed back to the repository, and the AI clean-up and merge assists
  are not offered on them. Connectors that name no specs sync exactly what
  they did. (#78)
- The drift check now compares a synced OpenAPI spec with the routes its
  repository declares. It reads NestJS controllers (`@ApiExcludeEndpoint`
  routes are left out), Express, Fastify, Hono and Koa routers, FastAPI
  decorators, and Go `net/http`, chi, gin, echo and gorilla routes. Tests,
  fixtures, examples and vendored code are not read. A route whose path is
  not a literal is counted, not guessed. A path matches whatever
  its parameters are named (`:id`, `{id}`, `{userId}`), and one uniform
  prefix such as `/v1` is allowed between the two sides. The check reports
  three things: an operation the spec documents that no route serves (missing
  in code), a route no spec documents (missing in spec), and a path whose
  methods differ. A pull request that edits a spec or a file declaring a route
  gets a finding on the spec page for each disagreement it introduces.
  Disagreements that predate the change are not reported. The one drift
  comment gains an **API specs** section with the spec's own diff (breaking /
  non-breaking) when the pull request edits it. A pull request that touches
  neither leaves the spec out. A repository with no supported framework is
  reported as not compared, never as every operation missing. On a spec page,
  editors can press **Check against the code** in the connector card to
  compare the default branch as it stands
  (`POST /v1/api-specs/:id/drift-check`, which queues a sentinel run). Neither
  path needs a model, and spec pages are never given an AI-written correction:
  the fix belongs in the repository's file. (#78)
- A styleguide: the rules your team agreed on for writing docs, in plain
  words, each with a severity (error, warning or suggestion). Admins write it
  under **Settings → AI → Styleguide**, for the whole workspace or for one
  project. A project's own styleguide replaces the workspace one there rather
  than adding to it, so a project can relax a rule. Every member can read the
  rules (`GET /v1/ai/styleguides`); admins write them with
  `PUT /v1/ai/styleguides` and delete them with
  `DELETE /v1/ai/styleguides/:id`. `POST /v1/assistant/lint` checks text
  against the styleguide of its project with the new `linter` agent. The
  panel's **Try it** box uses the same check. Each violation names the rule
  it breaks and quotes the passage. A violation that cites no rule of the
  styleguide, or quotes text that is not there, is dropped and counted in
  `dropped` rather than shown. The severity always comes from the rule. With
  no styleguide, the check makes no model call. Styleguides never appear
  among skills and never join a chat turn. (#74)
- Merge requests are checked against the styleguide. When a page's lint
  policy is `warn`, every push to an open, ready merge request is linted
  within about a minute, as its author. Only the lines the merge request adds
  are checked, so a violation already on the target branch is not reported.
  Each violation becomes a resolvable AI thread on the merge request,
  anchored to the quoted passage, naming the rule it breaks. A later push
  resolves the threads whose violation is gone and keeps the ones that still
  stand; a thread somebody resolved is never reopened, and threads people
  wrote are never touched. The merge widget and the AI pane show the check
  of the current head: waiting, running, passed, the number of violations,
  or why it did not run (no styleguide, a newer push, a page not open to
  every member, an author who cannot act, a spent AI budget, a failed run).
  **Check again** lints the head again. A `warn` check never holds a merge.
  The policy is set per workspace,
  and per project, under **Settings → AI → Styleguide** (`GET`/`PUT
  /v1/lint-policy`), where the panel shows both the setting and what
  applies. `GET /v1/merge-requests/:id/checks` lists a merge request's
  checks, `POST /v1/merge-requests/:id/checks/lint` re-runs one, and review
  threads gain `checkId` and `ruleId`. A page restricted to some members is
  not linted, because agent runs and their findings are listed to every
  member. (#74)
- A `block` lint policy holds a merge request until its style is fixed.
  Under it, `POST /v1/merge-requests/:id/merge` answers 409 with
  `details.reason: 'lint'` while the check of the source head is still to
  come, or while it has error-severity violations nobody has resolved
  (`details.checkStatus`, `details.blockingCount`, `details.checkId`).
  Resolving those threads lets the merge through; warnings and suggestions
  never hold it. A workspace admin can instead override the check of the
  current head with a required reason (**Override** in the merge widget,
  `POST /v1/merge-requests/:id/checks/:checkId/override`); the override is
  written to the audit log and shown in the merge request's activity, and
  it covers that revision only, so the next push is checked again. A check
  that could not run — a provider failure or a spent budget — does not hold
  a merge, and neither does a disabled `linter` agent. As with approvals,
  the gate is not enforced for the `AUTH_MODE=none` dev principal or an MCP
  client with no principal. `GET /v1/merge-requests/:id/checks` gains
  `gate` (what holds the merge now, for the caller) and each check its
  `override`. (#74)
- A new background agent, the **quality auditor**, scores every page from 0
  to 100. It measures six things: clarity and completeness (judged by the
  model), style against the page's styleguide, broken internal links (a
  `/documents/<id>` that no longer exists, or a title reference that matches
  no single page, by the same rule the reader renders with), whether the page
  has an owner, and near-duplicates (pages whose content is almost the same).
  A dimension it cannot measure, such as style with no styleguide or clarity
  with no model, is left out of the score, not counted as zero. Run it from
  the agents panel or on a schedule; it is off until then. Its findings are
  the pairs of likely duplicates and the pages below the quality threshold or
  with broken links. Each audit is kept, so later releases can show the
  history. A page is scored again only when it changed, the styleguide
  changed, or the score is older than the audit interval (7 days). Even then,
  an unchanged page keeps its earlier judgement and makes no model call, so
  re-running over an unchanged workspace costs nothing. Model calls appear in
  AI usage as `audit`. (#74)
- Quality scores are now visible. Knowledge health has a **Quality** tab:
  the average for the workspace or the active project, how many pages are
  scored, the average over time (one point per audit day, counting each
  page's newest score as of that day), the mean of each of the six
  dimensions, how the pages spread across score bands, the lowest-scoring
  pages and the styleguide rules broken most often. A page with a score gets
  a **Quality** widget in its side rail with the score, the six dimensions,
  what cost it points (the quoted passage, the rule, the broken link) and its
  near-duplicates; a project page gets the same summary in small. Scores
  below the auditor's threshold are marked. Every figure counts only pages
  you can open, and a near-duplicate you cannot open is not named. Over the
  API: `GET /v1/quality/summary`, `GET /v1/quality/documents` and
  `GET /v1/documents/:id/quality`. AI settings gains the audit interval
  (`qualityAuditDays`, how long an unchanged page keeps its score). (#74)
- Two MCP tools for agents: `knowledge_lint_draft` checks markdown against
  the styleguide of its project before the agent writes it (the same result
  as `POST /v1/assistant/lint`), and `knowledge_get_page_quality` returns a
  page's newest score, issues and history. Both are read-only and offered to
  read-only keys. (#74)
- The glossarist's proposals can now go straight into the glossary. Each
  proposed term in the agents panel has **Add to glossary**, which opens the
  term, aliases and definition the agent drafted so you can correct them,
  then adds the entry to the glossary of the project the term was found in,
  marked as suggested by AI. It makes no model call, and a term can be added
  from a finding only once; afterwards the finding links to the entry. Over
  the API: `POST /v1/ai/agents/runs/:id/findings/:index/add-term` (editor).
  The glossarist also no longer rereads the same 15 newest pages on every
  run: it skips any page it has already read at its current version, so
  repeated runs work through the whole workspace, most recently active pages
  first. A page you name on the run is always read. (#74)

- Settings → Profile now lists where you are signed in: each live session
  with how it was opened, its IP address, the browser and when it was last
  used. Sign any other session out from there and its token stops working on
  its next request. Over the API: `GET /v1/me/sessions` and
  `DELETE /v1/me/sessions/:sessionId`. A platform admin can list and sign out
  anyone's sessions without disabling the account:
  `GET /v1/users/:id/sessions` and `POST /v1/users/:id/revoke-sessions`.
  `GET /v1/me` now says how the current session was opened (`authMethod`),
  and each membership says who manages it (`source`, `manual` for every
  membership today). (#75)
- Settings → Security (workspace admins) shows the workspace's audit log for
  the first time: graph queries, page-access changes and admin bypasses,
  access requests, and the other recorded actions, newest first, filterable
  by action. Sign-ins, failed sign-ins, sign-outs and revoked sessions are
  now recorded too, with the client's IP. They belong to no workspace, so a
  platform admin sees them by switching the view to the whole platform, or at
  `GET /v1/admin/audit-logs`. `GET /v1/audit-logs` gains `action` and
  `cursor` filters and returns `nextCursor`; each entry now carries `ip` and
  `target`, and `workspaceId` can be null. This is the first phase of single
  sign-on and SCIM. (#75)
- Single sign-on with OpenID Connect. A workspace admin adds an identity
  provider under Settings → Security → Providers, from a preset for
  Keycloak, Microsoft Entra ID, Google Workspace, Yandex ID, or any OpenID
  Connect provider. The client secret is write-only: the API returns
  `hasSecret` and never the secret. The login page becomes email-first: the
  address decides whether the next step is a password or the organization's
  provider, and the workspace's providers appear as "Continue with …"
  buttons. Sign-in uses the authorization code flow with PKCE, a nonce and a
  single-use login transaction. A forged, replayed or expired attempt sends
  the browser back to `/login` with a reason and records a failed sign-in.
  The session token never appears in a URL: the browser trades a 60-second
  single-use code for it at `POST /v1/auth/sso/exchange`. A provider may
  create accounts on first sign-in (JIT) with a default role. It links to or
  creates an account only for an address the provider has verified, on a
  domain in the provider's allowed domains, so an unverified email claim can
  never take over an existing account. `GET /v1/me` reports
  `authMethod: 'oidc'` for these sessions, and SSO sign-ins appear in that
  workspace's audit log. A platform admin can make a provider platform-wide,
  so it is offered on every workspace's login page. Deleting a provider
  signs out the sessions it opened. (#75)
- Workspace roles from identity provider groups. Under Settings → Security
  → Group mapping, an admin maps a group from the provider's groups claim to
  a workspace role, and optionally to trusted operator. A workspace may map
  its own providers or any platform-wide one. Each SSO sign-in applies the
  mappings: the highest mapped role wins, and with no match the provider's
  role for new members applies in its own workspace. A provider's group sync
  is either **additive** (sign-in only raises a role) or **authoritative**
  (each sign-in sets the role from the groups, and removes the membership
  when no group maps). Mappings take effect at each person's next sign-in.
  Roles set by hand are never changed. Sign-in will not demote or remove a
  workspace's last admin: it skips the change and records it in the audit
  log. If Entra ID sends too many groups to list, sign-in takes nothing
  away. On Access → Members, a member managed by single sign-on shows where
  the role comes from. Editing that member's role answers 409
  `managedByIdp` until an admin chooses **Manage manually**
  (`PATCH …/members/:userId` with `convertToManual: true`). From then on,
  sign-ins leave that member alone. (#75)
- Enforced single sign-on. Under Settings → Security → Policy a workspace
  admin can require that every session reaching the workspace was opened
  through one of its identity providers (or a platform-wide one). The rule
  is checked on every request, for the web app, the API, MCP clients and
  live updates alike. A session that fails it gets 403 with
  `details.reason: 'ssoRequired'` and the providers to sign in through, and
  the web app sends the person to `/login` to sign in again that way. Keys
  keep working under enforced SSO unless the admin turns them off
  (`apiKeysBlocked`). A session age cap (`reauthRequired`) works with or
  without SSO. Platform admins pass the policy as break-glass, and each
  crossing is recorded in the audit log as `auth.sso_bypassed`. Saving a
  policy that would lock out the admin saving it (enforcing SSO from a
  password session, say) answers 409 `policyLocksYouOut`
  (`GET`/`PUT /v1/workspaces/:id/auth-policy`). Under Settings → Security
  → Domains an admin claims an email domain and proves it with a DNS TXT
  record at `_knowledge-challenge.<domain>`. The record is checked on demand
  and every 15 minutes for a week, and a platform admin may mark a domain
  verified by hand. Once a domain is verified, it can be enforced: password
  sign-in, signup and password reset are refused for its addresses (403
  `ssoRequiredForDomain`), and the login page sends them to the domain's
  provider. Addresses in `AUTH_BREAK_GLASS_EMAILS` still get in, and a
  workspace may let platform admins keep their password. A domain belongs
  to one workspace; a pending claim stops holding it after a week. (#75)
- SCIM 2.0 provisioning. An identity provider such as Microsoft Entra ID,
  Okta or Keycloak (with a SCIM plugin) can create, update, deactivate and
  delete a workspace's people and groups at `<API_PUBLIC_URL>/v1/scim/v2`.
  An admin creates a bearer token under Settings → Security →
  Provisioning; the token is shown once and only its hash is stored. A token
  provisions its own workspace only and opens no other route. Users and
  Groups support create, read, `PUT`, `PATCH` and delete. Lookups support
  `userName`, `externalId` and work-email `eq` filters for users, and
  `displayName` and `externalId` for groups, with paging. Entra's `"False"`
  strings and capitalised ops are accepted, as is Okta's member removal by
  filter. Errors are `application/scim+json` in the RFC 7644 shape. A new
  user gets an SSO-only account; an existing account with the same address
  is linked instead. A provisioned person gets the workspace's SCIM default
  role (`viewer` unless changed, or `none`). On the Group mapping tab, an
  admin can map a SCIM group to a role, and that applies to the group's
  members at once. Deactivating or deleting someone removes the membership
  provisioning manages and signs them out everywhere. Only when the
  address's domain is one this workspace has verified does it also disable
  the account and update the account's name and email; otherwise one
  workspace's directory could lock someone out of another. Memberships set
  by hand are never changed. Every provisioning change is in the audit log.
  (`GET`/`PUT /v1/workspaces/:id/scim`, `POST`/`DELETE
  /v1/workspaces/:id/scim-tokens`.) (#75)
- SAML 2.0 sign-in. Under Settings → Security → Providers, an admin picks
  **SAML 2.0** and enters the IdP's entity ID, single sign-on URL and signing
  certificate (paste two during a key rollover). Our service-provider key
  pair is generated when the provider is created; only its certificate
  leaves the API, in the SP metadata at
  `<API_PUBLIC_URL>/v1/auth/saml/:providerId/metadata`, which is also our
  entity ID. The ACS URL is `…/acs`. Both are shown for copying, and an IdP
  can import the metadata by URL. AuthnRequests are signed (RSA-SHA256). A
  response is accepted only if the Response or the Assertion is signed by
  the pinned certificate, the audience is our entity ID, the issuer is the
  configured one, and it is no older than `AUTH_SSO_STATE_TTL_SEC` (60 s
  clock skew). It must also answer the AuthnRequest that sign-in sent.
  Unsigned, wrongly signed, signature-wrapped, foreign or replayed responses
  send the browser to `/login` with a reason and are audited. Sign-ins
  started from the IdP's app portal are refused unless the provider allows
  them, and each assertion is accepted once. The **Attribute map** names
  the email, name and groups attributes. Left empty, the usual Keycloak,
  Okta, Entra and ADFS names are tried, then an email-format NameID; groups
  are read only from a named attribute. A transient NameID is refused. JIT,
  allowed domains, group mapping and enforced SSO work as for OpenID
  Connect. Sessions report `authMethod: 'saml'`. (#75)
- Sign in with an LDAP or Active Directory account. Where the instance
  allows it, a workspace admin can add a provider of kind **LDAP / Active
  Directory** under Settings → Security → Providers, with the directory URL,
  the base DN, an optional service account (its password is write-only, like
  a client secret) and an optional user filter. Its button on `/login` opens
  a username and password form instead of redirecting; the API also takes
  `POST /v1/auth/ldap/:providerId/login` with `{ username, password }`. The
  API binds as the service account, finds exactly one entry whose `uid`,
  `mail`, `sAMAccountName` or `userPrincipalName` is what was typed (the
  value is escaped, so filter syntax cannot widen the search), then binds as
  that entry with the typed password. A wrong username, a wrong password, an
  empty password, two matching entries and a disabled account all get the
  same 401, `Invalid username or password`, and the audit row records which
  it was. An unreachable directory is a 503. The account is identified by
  `entryUUID` or AD's `objectGUID`, never the DN, so renaming or moving
  someone keeps their account. Email, name and groups come from `mail`,
  `displayName` (or `cn`) and `memberOf` unless the attribute map names
  others; group mappings match the full group DN. JIT, allowed domains,
  group mapping and enforced SSO work as for the other kinds. Sessions
  report `authMethod: 'ldap'`. Sign-in attempts are rate-limited per IP and
  per username. (#75)
- OpenID Connect back-channel logout. When a person signs out at the
  identity provider, or an admin ends their session there, the provider can
  now tell us: register
  `<API_PUBLIC_URL>/v1/auth/oidc/<provider id>/backchannel-logout` (shown in
  the Providers tab) as the client's back-channel logout URL. The logout
  token must be signed by a key in the provider's JWKS, be issued by it for
  our client, be under 10 minutes old, carry the logout event and no
  `nonce`, and each token is accepted once. A token with a `sid` ends the
  sessions that IdP session opened; one with only a `sub` ends every session
  that person opened through that provider. Each logout is recorded as
  `auth.session_revoked`, and so is each refused token. The Yandex preset
  has no back-channel logout. (#75)
- The in-app manual (**Settings → Docs**) has a **Single sign-on & SCIM**
  article: what the operator must turn on, and how to set up Keycloak,
  Microsoft Entra ID, Google Workspace, Yandex ID, SAML, LDAP and SCIM
  provisioning, then require SSO without locking yourself out. (#75)

### Changed

- API blocks (the endpoint widget in the editor) and the operations of a
  spec now look like Swagger UI. Each endpoint is a card tinted by its
  method — GET blue, POST green, PUT amber, PATCH violet, DELETE red — with
  the method as a solid badge, so a page of endpoints reads at a glance in
  light and dark themes. Text inside the cards is larger and higher-contrast,
  and required parameters are marked as Swagger marks them.
  - An API block's sections (parameters, body, responses, headers) are rows
    with a count that open and close with a short animation. Find-in-page
    still reaches text inside a closed section and opens it. When reading, a
    section's table is drawn as name → type · location · required rows, with
    section names and column meanings in the reader's language; the values
    are never translated, and stored markdown is unchanged.
  - On a spec, each operation is one line (method, path, summary, a lock when
    it needs credentials) that opens in place. Specs with more than three
    operations start closed; **Expand all** opens every card. Parameters and
    responses are Name | Description and Code | Description tables, and every
    body has **Example** and **Schema** tabs. An example the spec does not
    give is built from the schema and labelled as such. The schema is a
    field tree: a closed field says what it holds ("3 fields", "array of 2
    fields", "one of 2 variants"), levels open with a short animation, and
    **Expand all** opens the whole schema. A type that refers to itself
    opens one more level per click instead of stopping, up to six levels.
    Examples and responses carry an always-visible **Copy JSON** button,
    ready to paste into Postman or `curl --data`.
  - "Try it" is laid out like Postman: one request bar with the method, the
    URL as it will be sent (filled path parameters highlighted, empty ones
    flagged) and Send; then **Params**, **Headers**, **Body** and **Auth**
    tabs with key/value tables; then the response with its status, time and
    size, and **Body** / **Headers** tabs. Code samples and JSON responses are
    syntax-highlighted. Pressing Send with a required field empty jumps to
    that field instead of doing nothing. (#78)

- Password sign-in is now rate limited to 30 attempts a minute per IP
  address and 10 a minute per email address. Past that it answers 429 with
  `Retry-After`. While Redis is down, password sign-in is refused rather
  than left unlimited. Settings → Security now opens on a Providers tab, with
  the audit log on its own tab. (#75)

### Fixed

- The web server no longer exits when a page's background request is
  refused during server rendering. A request the page did not wait for,
  answered with a 4xx, used to be an unhandled rejection, which stopped the
  process and every render in flight. It is now logged; any other unhandled
  rejection still stops the process. Enforced SSO made this common: every
  page a password session opened in an enforcing workspace hit it. (#75)
- Live updates no longer ignore a subscription sent the moment the socket
  opens. A client that subscribed from `onopen` got no reply and no error,
  because the server started listening only after it had checked the token.
  Messages that arrive during that check are now answered once it finishes,
  in the order they came. (#75)

### Operations

- Migration `20261103100000_api_reference_kind` adds `documents.kind`
  (default `'page'`), `documents.spec_slug` and the `api_operations` table.
  It is additive, so rolling back to the previous image is safe.
- New env vars, both with defaults: `API_SPEC_MAX_BYTES` (5000000) and
  `API_SPEC_MAX_OPERATIONS` (2000). A spec above either limit is refused.
- Migration `20261104100000_workspace_settings` adds the sparse
  `workspace_settings` table (one row per workspace, `null` inherits). It is a
  new table, so rolling back to the previous image is safe: that image never
  reads it.
- New env vars, all with defaults: `API_TRY_PROXY_MODE` (`off`; a ceiling the
  workspace can only narrow: `off` | `allowlist` | `open`),
  `API_TRY_ALLOW_PRIVATE_URLS` (`false`), `API_TRY_TIMEOUT_MS` (15000),
  `API_TRY_MAX_RESPONSE_BYTES` (1000000) and `API_TRY_RATE_PER_MINUTE` (30).
  With the defaults the proxy refuses every request, so nothing changes until
  an operator raises the ceiling. The rate limit uses Redis and fails closed.
- Migration `20261105100000_api_breaking_changes` adds the nullable
  `workspace_settings.api_breaking_change_policy` and
  `merge_requests.breaking_ack_by` / `breaking_ack_at` /
  `breaking_ack_revision_id`. No backfill: an empty policy is `warn`, which
  never refuses a merge. The previous image never reads them, so a rollback is
  safe.
- Migration `20261106100000_styleguide` adds `ai_skills.kind` (NOT NULL,
  default `'skill'`, so no backfill), `ai_skills.project_id`,
  `ai_skills.rules` and a partial unique index allowing one styleguide per
  workspace or project. The previous image does not know about `kind`, so
  after a rollback it would list a styleguide as an empty skill. Delete
  styleguides before rolling back:
  `DELETE FROM ai_skills WHERE kind = 'styleguide'`.
- New env vars, both with defaults: `STYLEGUIDE_MAX_RULES` (50) and
  `LINT_MAX_FINDINGS` (15).
- Migration `20261107100000_merge_request_checks` adds the
  `merge_request_checks` table, `merge_request_threads.check_id` /
  `rule_id`, `workspace_settings.lint_policy` and `projects.lint_policy`. All
  additive and nullable, and the previous image reads none of them, so a
  rollback is safe.
- New env vars, both with defaults: `STYLE_LINT_POLICY` (`off`) is the
  ceiling, and the policy of every workspace that sets none, for merge
  request lint (`off` | `warn` | `block`). With the default nothing is linted anywhere
  and the trigger does not even query. `LINT_MAX_PENDING_PER_WORKSPACE` (20)
  bounds the checks one workspace may have waiting. Each check is one model
  call per push, billed to the merge request's author. Raising the ceiling
  to `block` makes `block` the policy of every workspace and project that
  sets none, so merges there wait for their style check.
- Migration `20261108100000_document_quality_scores` adds the
  `document_quality_scores` table and the nullable
  `ai_settings.quality_audit_days`. Both are additive and the previous image
  reads neither, so a rollback is safe.
- New env vars, all with defaults: `QUALITY_AUDIT_MAX_PAGES` (200, pages one
  auditor run scores, one model call each at most), `QUALITY_AUDIT_DAYS` (7),
  `QUALITY_DUPLICATE_THRESHOLD` (0.92, the mean-embedding similarity two pages
  must reach to be called near-duplicates) and `QUALITY_FINDING_THRESHOLD`
  (50). Nothing runs until someone runs or schedules the `auditor`. On
  `EMBEDDINGS_PROVIDER=stub` the near-duplicate check is skipped and the run
  says so, because the stub's similarity measures shared words rather than
  shared meaning.

- Migration `20261109100000_enterprise_auth` prepares single sign-on and
  SCIM (#75). It adds session metadata columns to `sessions` (`auth_method`
  defaults to `'password'`), `workspace_members.source` (defaults to
  `'manual'`), `audit_logs.ip` and `audit_logs.target`, four nullable sign-in
  policy columns on `workspace_settings`, and the tables `identity_providers`,
  `user_identities`, `sso_domains`, `idp_group_mappings`, `scim_tokens`,
  `scim_users`, `scim_groups`, `scim_group_members` and `sso_auth_requests`,
  which stay empty until later phases. `audit_logs.workspace_id` becomes
  nullable. Every change is additive, nothing is backfilled, and the previous
  image only reads audit rows filtered by workspace, so rolling back is safe.
- Single sign-on is off unless `AUTH_SSO_ENABLED=true`. Turning it on needs
  `AUTH_MODE=api-key`, and `SETTINGS_ENCRYPTION_KEY` to store a provider's
  client secret. Register `<API_PUBLIC_URL>/v1/auth/oidc/<provider id>/callback`
  as the redirect URI at the provider; the Providers tab shows the exact
  value. New variables, all defaulted so an existing deployment behaves as
  before: `AUTH_SSO_ENABLED` (`false`), `AUTH_SSO_ALLOW_PRIVATE_URLS`
  (`false`; set it for an on-premises Keycloak on a private address),
  `AUTH_SSO_STATE_TTL_SEC` (`600`), `AUTH_PASSWORD_LOGIN_ENABLED` (`true`;
  `false` makes login, signup and forgot-password refuse every address
  except those in `AUTH_BREAK_GLASS_EMAILS`) and `AUTH_BREAK_GLASS_EMAILS`
  (empty). Migration `20261110100000_sso_request_idp_session` adds one
  nullable column, `sso_auth_requests.idp_session_id`, which the previous
  image never reads, so rolling back is safe. `make infra-up-keycloak`
  starts a local Keycloak with a test realm for trying SSO out. (#75)
- Enforced SSO adds no migration and no environment variable; the policy
  columns and `sso_domains` came with `20261109100000_enterprise_auth`. With
  `AUTH_SSO_ENABLED` off, no SSO policy or domain is enforced, whatever a
  workspace saved, and the Policy tab shows the setting as not applied. When
  SSO is on, the API checks pending domains every 15 minutes and so needs
  outbound DNS. The same pass deletes expired login transactions and
  expired sessions. (#75)
- SCIM provisioning is off unless `AUTH_SCIM_ENABLED=true`, which needs
  `AUTH_MODE=api-key` and is independent of `AUTH_SSO_ENABLED`. While off,
  `/v1/scim/v2` and the Provisioning settings answer 404. New variables:
  `AUTH_SCIM_ENABLED` (`false`) and `AUTH_SCIM_MAX_PAGE` (`200`, the largest
  list page a client may ask for). Bodies sent as `application/scim+json`
  are now parsed as JSON. Migration `20261111100000_scim_provisioning` adds
  `workspace_settings.scim_default_role` and `scim_users.user_name` with a
  unique index per workspace. Both are nullable, nothing wrote to
  `scim_users` before, and the previous image reads neither, so rolling back
  is safe. (#75)
- SAML sign-in adds no migration and no environment variable. It uses the
  columns `20261109100000_enterprise_auth` added, and it is on with the
  rest of SSO (`AUTH_SSO_ENABLED`). Creating a SAML provider needs
  `SETTINGS_ENCRYPTION_KEY`, which encrypts the generated SP private key;
  rotating that key leaves existing SAML providers unable to sign in until
  they are recreated, and their **Test** says so. The SSO URL must be
  `https` unless `AUTH_SSO_ALLOW_PRIVATE_URLS` is set. The API never fetches
  it, so SAML needs no outbound network. Rolling back to an image without
  SAML leaves SAML providers in place but unusable. (#75)
- LDAP sign-in is off unless both `AUTH_SSO_ENABLED=true` and
  `AUTH_LDAP_ENABLED=true`. Turning `AUTH_LDAP_ENABLED` off again takes LDAP
  providers off the login page and refuses their sign-ins at once, and
  workspaces that enforce SSO stop counting them. A directory must be reached
  over `ldaps://`, or `ldap://` with StartTLS; plain `ldap://` is refused,
  when the provider is saved and at every sign-in, unless
  `AUTH_LDAP_ALLOW_INSECURE=true`, which sends passwords in clear text and
  is meant for a lab. A directory on a private address, which is the usual
  case, needs `AUTH_SSO_ALLOW_PRIVATE_URLS=true`. The directory's TLS
  certificate is checked against the system CAs; for an internal CA, point
  `NODE_EXTRA_CA_CERTS` at it in the API container. Storing a service
  account password needs `SETTINGS_ENCRYPTION_KEY`. New variables:
  `AUTH_LDAP_ENABLED` (`false`) and `AUTH_LDAP_ALLOW_INSECURE` (`false`).
  New dependency: `ldapts`. No migration. (#75)
- Back-channel logout needs the API to reach the provider's JWKS URL, as
  sign-in already does. It adds no migration and no variable. Rolling back
  to an image without it makes the IdP's logout calls fail (404), and those
  sessions then run to their normal expiry. (#75)

## [0.26.0] — 2026-10-16

### Added

- The captures inbox can be narrowed to one API key, and an editor can turn
  down everything that key proposed and is still pending in one step: its
  staged captures are rejected and the open merge requests they opened are
  closed. Each capture still gets its own entry in the activity log, merged
  captures are left alone, and the confirmation shows the counts before
  anything changes. Every row now shows the key that wrote it (name and
  prefix), and Connect AI links each key to its captures, including from the
  toast after revoking one. Over the API: `GET /v1/captures?apiKeyId=` (another
  person's key needs an editor) and `POST /v1/captures/bulk-reject`
  `{ workspaceId, apiKeyId, reason?, dryRun? }`, which a capture key cannot
  call. (#235)
- `make backtest ARGS="--captures --workspace <id>"` measures the capture
  dedupe and amend thresholds on a workspace's own pages: each case class's
  score percentiles and, for every threshold from 0.50 to 0.98, how often it
  would scatter a subject, amend the wrong page, miss a restatement or drop
  new knowledge. `--reembed` measures whatever embedding model the env
  names against the same pages without reindexing them, such as the stub, or
  a model you are thinking of switching to. Read-only. On bge-m3 the 0.92 / 0.80 defaults came out within
  noise of the best values, so they are unchanged. On the hash stub, which
  production runs, no amend threshold works; a dedupe override of 0.78 is
  suggested there. (#234)

### Fixed

- `knowledge_find_similar` could tell an agent a capture would amend a page
  (or was a duplicate) and the capture then did something else, because the
  probe scored the bare body while the capture scored its title and body. Pass
  the `title` and `kind` you will capture with and the probe now scores the
  same text and returns `decision` (`duplicate`, `amend` or `new-page`) as the
  capture will decide it. A call with `text` alone behaves as before. The
  capture playbook and the capture kit's hook reminder say so; the kit is now
  v2, so re-fetch it to pick up the new reminder. (#233)

## [0.25.0] — 2026-10-16

### Added

- Every pull of a codebase connector now records which files import which,
  and which names they take, for the commit it read. It covers relative
  imports, `tsconfig` path aliases (`@/…`), workspace packages
  (`@knowledge/contracts/core`), `.vue` / `.svelte` script blocks, lazy
  `import()`s, and imports that reach a file through a barrel `index.ts`.
  Python resolves relative imports only; other languages resolve none yet.
  Nothing reads the index yet. It is the base for component pages and
  "Used by" in the next phases. (#236)
- A page can declare the code it documents with a `component:` frontmatter
  block (`repository`, `paths`, `symbols`), and a new built-in **Component**
  template writes one. After each codebase pull, a page documenting a file
  that imports a declared component gains a `DEPENDS_ON component:<name>`
  edge, derived from code and never editable. So `knowledge_impact_analysis`
  on the component lists the pages documenting its users. A page "documents"
  a file when its own `component.paths` cover it, or else the wiki module
  page for the file's directory does. When a declaration matches no
  connector (none in the workspace, an unknown or ambiguous `repository`, or
  no paths), the page shows a warning and gets no edges. (#236)
- A component page has a **Used by** panel in its right rail. It lists every
  file that imports the declared code at the connector's indexed head, what
  each one imports, and the pages documenting each file. With `symbols`
  declared, a file that imports the module but none of those names is left
  out. Every path is shown. A documenting page the reader cannot open shows
  as a count, never a title. The same answer is available by page or by path
  through `GET /v1/documents/:id/component/usages`, `GET /v1/code-usages`
  and the new read-only MCP tool `knowledge_code_usages`, so an agent can ask
  "what uses this file, and which docs move?" before editing it. (#236)
- The pull request drift check now follows component declarations. A page
  whose `component.paths` cover a changed file is checked first. Next come
  the pages documenting the files that use the changed component, under the
  same per-check page limit. Importers the pull request itself adds or
  removes are counted, because the changed files are read again at the
  head of the pull request. The check's comment gains an **Affected usages**
  section: the usage files grouped by the page that documents them, with
  pages past the limit marked "not checked", restricted pages counted and
  undocumented usage files listed. A pull request that touches a component
  now gets this comment even when no page drifted. (#236)
- When a pull request removes or moves a file a component page declares,
  the check reports it without a model. In `propose` mode it opens a merge
  request that rewrites the page's `component.paths`, together with the
  corrected text when the page also drifted. Propose on that finding in the
  runs panel does the same, and it never calls the drafter. If nothing in
  the declaration would be left, the finding says the component is gone and
  proposes nothing. (#236)
- **Document this component**: in a component page's Used by panel, an
  editor can press **Document** on a usage file that no page documents.
  The archaeologist reads the file from the codebase connector, fills the
  Component template's sections from the code, and the page opens as a
  merge request by the person who pressed it. The page stays hidden from
  lists and search until the merge request merges. Its `component:` block
  names exactly the files that were read. The panel shows the draft's
  progress and then links to the merge request. The same action is
  available as `POST /v1/components/drafts` (one to ten files, an optional
  name, symbols and placement) and as the MCP write tool
  `knowledge_document_component`, which read-only keys are not offered.
  A request is refused when a page you can open already declares one of
  the files, or when a draft of the same files is still running or
  waiting in an open merge request. It is also refused when the
  archaeologist has no model. Model spend shows as **Component draft** on
  the usage page. (#236)
- The knowledge-health dashboard has a **Missing code** filter: component
  pages that declare a path no file matches at the connector's indexed
  head, such as a file that was deleted or moved, a directory that was
  emptied, or a glob that matches nothing. Each row shows how many paths
  are missing and names them on hover, and the page itself says which
  declared paths are gone. Fixing `component.paths` clears the page right
  away. A file the index skips for size or for being binary still counts
  as present. The feature is documented in
  [docs/features/51](docs/features/51-component-pages.md). (#236)

### Changed

- The repo wiki's Architecture page now counts `export … from` re-exports as
  dependencies between modules. If that adds an arrow, the page is
  regenerated once on the next pull. (#236)

### Operations

- Migration `20261030100000_code_imports` adds the `code_imports` table. The
  change is additive, so rolling back to the previous image is safe. The
  table starts empty and fills on each codebase connector's next pull. A
  failure to write it shows as a run warning and never fails the pull.
  (#236)
- Migration `20261031100000_component_declarations` adds the
  `component_declarations` table. It is additive, so rolling back is safe.
  It fills as pages with a `component:` block are next indexed. Existing
  pages need an edit or a reindex to be picked up. (#236)
- Migration `20261101100000_agent_run_details` adds the nullable
  `agent_runs.details` column, where a drift check keeps its affected
  usages for the comment. It is additive, so rolling back is safe; the
  previous image ignores the column. Each component-touching check now
  downloads the connector's repository snapshot (once per process per
  `CODE_SNAPSHOT_TTL_MS`, the cache the code tools already use) and makes
  one host request per changed source file, at most 60 per check. A check
  that touches no component page does neither. (#236)
- Migration `20261102100000_component_missing_paths` adds the `code_files`
  table (every file at a codebase connector's indexed head) and the
  `component_declarations.missing_paths` column, which defaults to empty.
  It is additive, so rolling back is safe. Both fill on each codebase
  connector's next pull; until then the Missing code filter is empty.
  (#236)

## [0.24.0] — 2026-10-16

### Added

- API keys have a third scope, **capture** ("Read & propose" on the Connect AI
  page), for coding agents that will propose what they learned in a session
  as merge requests. A capture key reads like a read-only key and can never
  write a page, merge, approve, sync or ingest. Only the agent-memory tools
  may lift it to editor. `POST /v1/me/api-keys` takes `projectIds` to pin a
  capture key to up to 20 projects; any other scope with a pin is refused.
  (#73)
- The workspace AI settings carry the capture switch, the per-key hourly and
  per-workspace daily limits, the two dedupe thresholds and a default parent
  page (`PATCH /v1/ai/settings`; `capture` in the response shows asked against
  applied for each). (#73)
- Coding agents connected over MCP can now hand back what they learned in a
  session: `knowledge_capture_decision`, `knowledge_capture_note` (gotcha,
  convention, how-to), `knowledge_propose_relation` and
  `knowledge_propose_answer` (cited pages required) each open a merge request
  for a person to review, and change nothing until it is merged. A capture
  close to an existing page becomes a section on that page; one the knowledge
  base already says, or the same capture sent twice, comes back as
  `duplicate` and opens nothing. `knowledge_propose_glossary_term` holds a
  term for an editor's approval. `knowledge_find_similar` lets an agent check
  first, and `knowledge_list_captures` shows where captures went. Captures
  carrying something that looks like a credential are refused without being
  stored; over the per-key or per-workspace limit they get a 429 with
  `retryAfterSec`; a capture key pinned to projects cannot write outside
  them. (#73)
- Merge requests say who opened them: `provenance` is `manual`, `agent` (an
  agent finding or an assistant proposal) or `captured` (an agent session or
  a chat save), with `captureId` for a capture's. `GET /v1/merge-requests`
  filters on `provenance`. (#73)
- Captures over REST: `POST /v1/captures` takes the same captures as the MCP
  tools (one body, discriminated by `kind`), `GET /v1/captures` and
  `GET /v1/captures/:id` list and read them. `POST /v1/captures/:id/approve`
  turns a term waiting in the inbox into a glossary entry with source
  `captured`; `POST /v1/captures/:id/reject` turns down anything still
  staged. A page or relation capture is already a merge request, so both
  answer 409 for it and point at the merge request. A capture key can create
  captures but never approve or reject them. (#73)
- `POST /v1/assistant/messages/:id/capture` saves an assistant reply to the
  knowledge base as a merge request: the question before it, the answer
  without its `[S#]` labels, and its cited pages. A reply that cites no page
  is refused. (#73)
- A capture interrupted by an API restart between staging and proposing is
  now finished by a sweeper within `CAPTURE_STALE_MS`, as the person who
  wrote it, instead of staying staged. (#73)
- A **Captures** page in the sidebar ("Предложения агентов" in Russian) lists
  what agents proposed, by Staged, Proposed, Duplicates, Rejected and Failed,
  filterable by kind, project and "only mine". Each row shows which agent sent
  it, from which repository, branch and commit, what dedupe made of it and the
  pages it was compared with. Glossary terms are approved or rejected there;
  page and relation captures link to their merge request. The list updates
  live as captures arrive and their merge requests merge or close. `GET
  /v1/captures` rows now carry the capture's `payload`. (#73)
- Merge requests opened by an agent carry an **Agent** or **Captured** badge in
  the list, the search bar offers "Captured from agent sessions" and an
  "Opened by" filter, and a captured merge request's page shows the agent,
  repository, branch and session it came from. (#73)
- Assistant replies that cite a page have a **Save to knowledge base** action,
  which proposes the answer as a merge request and links to it. (#73)
- **Settings → AI → Agent memory** sets whether agents may propose, the two
  rate limits (with the deployment's cap shown beside them), the duplicate and
  amend thresholds, and the parent page for new captured pages. The Connect AI
  key form can pin a Read & propose key to projects, and the key list shows the
  pin. Glossary terms approved from captures are badged and filterable. (#73)
- A **capture kit** for Claude Code and Cursor: a skill (or rule) that says
  what is worth capturing, and a hook that, once per session and only after
  the agent edited a file, reminds it to propose what it learned. The hook
  holds no key and calls nothing. Step 4 of the Connect AI page installs it
  with one command run inside the repository; an existing
  `.claude/settings.json` or `.cursor/hooks.json` is merged into with `jq`
  (re-running updates, never duplicates) or left alone with the entries
  printed. Over HTTP: `GET /v1/mcp/capture-kit?client=claude-code|cursor`
  returns the files, `/v1/mcp/capture-kit/install` the installer script; a
  read-only key gets 403. The generated `SKILL.md` gains a "Capture memory"
  section when the key is offered the capture tools, and `knowledge_whoami`
  reports a capture key's project pin. (#73)

### Changed

- A page saved from a chat, and a page a capture proposes, no longer appears
  in the page tree, page lists, knowledge health, exports, published sites or
  `llms.txt` while its merge request is open. It joins them when the merge
  request merges, and stays readable by its link meanwhile. Closing the merge
  request leaves the empty page hidden. (#73)

### Fixed

- Opening the diff of a merge request that gives a page its first content
  (a page saved from a chat) failed with 400 "has no revisions to diff
  against". It now shows every line as added; `compare.from` is `null` in
  that case. (#73)

### Operations

- New env vars, all with defaults: `CAPTURE_ENABLED` (true),
  `CAPTURE_PER_KEY_PER_HOUR` (30), `CAPTURE_PER_WORKSPACE_PER_DAY` (500),
  `CAPTURE_DEDUPE_THRESHOLD` (0.92), `CAPTURE_AMEND_THRESHOLD` (0.8),
  `CAPTURE_MAX_CHARS` (8000), `CAPTURE_SWEEP_INTERVAL_MS` (60000) and
  `CAPTURE_STALE_MS` (300000). The switch and the two limits cap the
  workspace settings. (#73)
- Migration `20261028100000_agent_captures` adds the `knowledge_captures`
  table, `merge_requests.provenance` (default `manual`) and `capture_id`,
  `api_keys.project_ids`, and six nullable `ai_settings` columns. It is purely
  additive and survives a rollback: the previous release ignores all of it.
  (#73)
- Migration `20261029100000_capture_pending_pages` adds
  `documents.pending_merge_request_id`, hides the chat-saved pages whose merge
  request has not merged, and marks existing merge requests opened from agent
  findings `agent` and from chat saves `captured`. Additive; a rollback shows
  those empty chat-saved pages in the tree again, as before. (#73)

## [0.23.0] — 2026-10-16

### Added

- Search on a published site can be narrowed by **category** and **tag**.
  The filter rail offers only the categories and tags of pages the reader can
  see in the version they are on, with page counts, and results show each
  page's tags. A frozen version filters by the categories and tags it was
  built with. Search on a site still never offers a workspace, project or
  mode, and the public search route now refuses those parameters (400)
  instead of ignoring them. (#205)

### Changed

- A published site's search is now drawn by the app's own search sheet,
  result list and filter fields, so the two look and behave the same. On a
  phone the search field and its button no longer get pushed off-screen by a
  long result, in the app's search sheet too. (#205)

- A published site's page list now looks and behaves like the app's sidebar
  tree. Pages expand and collapse with a chevron, and opening a branch loads
  only that level, with a spinner on the row while it loads. Before, a site
  sent every page title on every page load, which slowed down large sites.
  Without JavaScript, the top level and the path to the current page still
  render as plain links. (#204)
- The site reader now uses the full window width. The page list is pinned to
  the left edge and scrolls to the current page; the content fills the rest,
  and prose keeps a readable line length. On narrow screens the page list is
  a drawer behind the header's menu button. It also opens without
  JavaScript. (#204)

### Fixed

- The **⋯** menu on a page in the sidebar tree opened in the top-left corner
  of the window instead of beside the row. It now opens next to the row and
  stays there when the pointer leaves it. (#203)
- Search no longer fails when OpenSearch is down, restarting or slow.
  `/v1/search`, the search widget, MCP `knowledge_search` and the assistant's
  search tools now answer from vector results alone and report
  `degraded: ["fulltext"]`. Before, any OpenSearch error failed the whole
  request. A keyword search falls back to the vector index instead of
  returning nothing. (#173)
- Pages indexed or re-pointed while OpenSearch was down no longer drop out of
  keyword search, and superseded text no longer stays ranked there. The
  worker's stale sweeper repairs them from the graph within a few sweeps of
  OpenSearch coming back, with no reindex and no re-embedding. (#173)
- Per-IP limits on public routes count each visitor again. In production
  every request reached the API with Cloudflare's address, so all visitors
  behind one Cloudflare location shared a single allowance: one person's
  share-link password guesses or published-site questions used up everyone
  else's. The web server's site-host check also saw the Funnel name instead of
  the visitor's host, which would have served a published site's domain as the
  member app once base or custom domains are turned on. (#174)

### Operations

- Migration `20261027100000_site_search_facets` adds `category` (backfilled
  from each page's current category) and a nullable `tags` column to
  `site_version_pages`. It survives a rollback: the previous release neither
  reads nor writes them. On first boot the worker reads the frontmatter of
  every published revision once to fill `tags`; until it finishes, site
  search returns those pages untagged and a tag filter does not match them. (#205)
- New env var `FULLTEXT_TIMEOUT_MS` (default `1500`): how long a search waits
  for OpenSearch before answering without it. Only read when
  `FULLTEXT_PROVIDER=opensearch`.
- Migration `20261026100000_fulltext_stale_at` adds a nullable
  `document_revisions.fulltext_stale_at` column and its index. It survives a
  rollback: the previous release neither reads nor writes it. Revisions that
  drifted before this release are not stamped; run `POST /v1/ingestion/reindex`
  once if keyword search has been missing pages.
- New **required** secret `EDGE_SECRET` (#174), for Caddy, and the same value
  as the edge Worker's binding. Set it in the GitHub `production` environment
  as a **secret** (`openssl rand -hex 32`, hex only) before tagging: without it
  the deploy stops at "Render .env". Then deploy the Worker, which now lives in
  `deploy/edge/`: `EDGE_SECRET=<value> deploy/edge/deploy.sh`. The order does
  not matter; until both hold the same value, requests are counted against
  Cloudflare's address as before. To rotate: new value → Worker → environment
  → redeploy (`gh workflow run deploy.yml --ref vX.Y.Z`).

## [0.22.0] — 2026-10-15

### Added

- **User groups** in **Settings → Access → Groups**: named sets of workspace
  members that page and project restrictions will be granted to. Workspace
  admins create, rename and delete groups and add or remove members. Everyone
  else in the workspace can see them. Groups mirrored from a connector or
  provisioned by SCIM are shown read-only, and the API answers 409 to an edit.
  Removing someone from the workspace also removes them from its groups. The
  routes are `/v1/groups` and `/v1/groups/:id/members`. (#76)
- A **guest** workspace role, below viewer. A guest can open only pages and
  projects shared with them or one of their groups, and sees just those in the
  page tree, the page list, the project list and search results. Every other
  page answers 404. A guest's activity feed shows only rows about those pages,
  and they are notified only about those pages. Other workspace-level routes,
  such as the member roster and settings, still refuse a guest. A guest
  cannot be made a reviewer, a page owner or a member of a members-only
  site. MCP `knowledge_whoami` reports the role. (#76)
- **Page and project restrictions.** Anyone who can edit a page can restrict it
  from **Access** in the page header or the tree menu, granting view, edit or
  manage to people or groups; workspace admins can restrict a whole project.
  A restricted page is hidden, with everything under it, from everyone it does
  not name: it leaves the tree, page lists, project counts and overviews,
  merge-request lists, the knowledge-health dashboard, profiles, the graph
  views and entity lookups, and its ancestors' breadcrumbs for a guest. A child
  can narrow its parent's restriction but never reopen it, and a page moved
  under a restricted parent is restricted at once. The workspace role stays
  the ceiling (a viewer with an edit grant still only reads), and workspace
  admins still see everything; each time they open a restricted page they were
  not granted, it is recorded in the audit log. Opening a restricted page
  without access answers 403 with `details.canRequestAccess` and no title, and
  **Access → Who can see this** lists everyone who can, with their level. A
  restricted page cannot be shared by public link, an existing link to it stops
  working, and published sites, `llms.txt` and exports leave it out for anyone
  who may not open it. MCP's page, merge-request and project tools and its
  tree, graph and project listings apply the same rules. Routes:
  `GET|PUT /v1/documents/:id/access`, `GET /v1/documents/:id/access/effective`,
  and the same under `/v1/projects/:id`. (#76)
- **Search respects page restrictions.** `POST /v1/search`, the assistant's
  `search_knowledge` tool, **Related pages** in the editor and MCP
  `knowledge_search` return only pages the caller can open, in semantic,
  keyword and hybrid mode. Graph expansion neither walks through a hidden page
  nor lists an entity that only hidden pages mention, and the same holds for
  the graph view and entity lists. A change to a restriction applies to the
  next search. A search still fills its `limit` when enough visible pages
  match. (#76)
- **The assistant, agents, workflows and chat bots respect page
  restrictions.** Every assistant tool reads only pages the person asking can
  open, checked again on each tool call, so access removed during an answer
  holds from the next step. A page they cannot open is "not found" to the
  model. Proposing an update or a relation change needs edit on the page.
  Output that more people read than the person it acts for is held to what
  those readers could open: agent runs (whose findings every member sees, and
  whose pull-request comments leave the workspace) and bot answers in a group
  chat use only pages open to the whole workspace. Chat digests list only
  those pages, and a workflow's search step uses only pages at least as open as
  the page the workflow runs on. MCP guests can now use `knowledge_search`,
  `knowledge_list_documents` and `knowledge_list_projects`, scoped to their
  grants, and the new read tool `knowledge_get_page_access` tells an agent why
  a page is or is not open to it. (#76)

- **Access requests.** Someone refused a page or project can ask for view or
  edit right on the refusal screen, with a note. The people who manage it and
  the workspace admins are notified. They approve (choosing the level) or
  decline (optionally saying why) under **Settings → Access → Requests**, and
  the requester is notified of the answer. A pending request expires after 30
  days. Approving grants the level on every restricted page or project that
  kept the requester out, since a grant under a closed parent would admit no
  one. Asking twice answers 409, and a guest asking about a page they cannot
  open gets a 404, so a request is never a way to learn that a page exists.
  New notification category **Access**. MCP gains `knowledge_request_access`,
  a write tool hidden from read-only keys. Routes: `POST|GET
  /v1/access-requests` and `POST /v1/access-requests/:id/approve|deny|cancel`.
  (#76)
- **Notifications, the activity feed and live updates respect page
  restrictions.** A notification about a page reaches only people who can open
  it, however they came to watch it. Naming someone in a comment who cannot
  open the page does not notify them; the comment response lists them in
  `mentionedWithoutAccess`, and the page warns the author and offers
  **Access…**. The activity feed and the profile calendar leave out rows about
  pages the reader cannot open, and its cursors still page correctly. SSE and
  WebSocket clients receive no events about pages they cannot open, and every
  client gets an `acl.changed` event (naming no page) when a restriction, a
  grant or a group's membership changes, so open trees and lists refresh. A
  person granted access directly from the Access dialog is notified. (#76)

- **Connectors can mirror source permissions.** A connector's new **Access**
  tab (workspace admins) switches on access mirroring. A Confluence page with a
  read restriction, on itself or an ancestor, is imported restricted to the
  same people and groups, and a page from a private GitHub repository to its
  collaborators and teams; a public repository's pages stay open. Upstream
  groups appear as read-only groups. People are matched by a linked GitHub
  account or a verified email, and anyone unmatched is listed on the tab, where
  an admin can map them by hand. **Mirror, fail closed** also admits the
  connector's owner wherever someone is unmatched. Notion and Jira pages can be
  restricted to one chosen group. Permissions are re-read on their own
  interval without fetching content, so a restriction lifted at the source is
  lifted here on the next access sync; **Sync access now** queues one at once.
  Grants added by hand on a mirrored page are kept, and the page's Access
  dialog shows the mirrored ones read-only. The GitHub access card lists
  `members: read` for this. Routes: `GET|PUT /v1/connectors/:id/acl`,
  `PUT /v1/connectors/:id/acl/identities/:identityId` and
  `POST /v1/connectors/:id/acl/sync`. (#76)
- `make backtest ARGS="--generate --as <userId>"` measures known-item search
  recall as one person sees it, through their page restrictions. Pages they
  cannot open are left out of the question set, not counted as misses. Page
  permissions are written up in `docs/features/48-page-permissions.md`. (#76)
- Agent schedules can now run at a time of day: **Daily** at HH:MM, or
  **Weekly** on chosen weekdays (Mon–Fri at 09:00, say), in an IANA timezone
  that defaults to the browser's. The editor in **Settings → AI → Agents**
  shows the next run, and so does `nextRunAt` on `GET /v1/ai/agents`. A run
  starts within five minutes of its slot. If the worker was down across
  several slots, the schedule runs once when it comes back, not once per missed
  slot. Changing a schedule never fires a slot the change moved into the past.
  Interval schedules work as before. `PATCH /v1/ai/agents/:key` takes
  `scheduleKind`, `scheduleTime`, `scheduleWeekdays` and `scheduleTimezone`.
  (#70)
- `POST /v1/ai/agents/:key/run` takes `documentIds` (up to 20), which limits
  a curator, reviewer or glossarist run to those pages instead of the most
  recent ones. Pages the caller cannot open are skipped. Any other agent
  answers 400. (#70)
- **Agent triggers** start a background run when something happens in the
  workspace: a page is merged, a page is updated (a new revision indexed on its
  default branch, or a named branch), a merge request or a connected
  repository's pull request is opened, or a connector finishes a sync. Add
  them in **Settings → AI → Agents**, in an agent's dialog, optionally narrowed
  to a project, page categories, connectors or a branch. A trigger is off until
  an admin enables it, and its runs execute and bill as whoever enabled it. A
  page-reading agent's run reads just the page the event is about. The same
  page, merge request or connector starts at most one run per cooldown (60
  minutes unless set), never while a run of that agent for it is still going,
  and a re-index of a revision that already fired starts nothing. Runs show
  what started them in **Runs**. Routes: `GET /v1/ai/agents/triggers`,
  `POST /v1/ai/agents/:key/triggers`, `PATCH|DELETE /v1/ai/agents/triggers/:id`
  (admin). (#70)
- **Webhook triggers** let any system that can sign a request start an agent
  run. Add a "A signed webhook arrives" trigger to an agent, press **Create
  secret**, and give the sender the URL and the secret, which is shown only
  once. The sender POSTs JSON to `/v1/ai/agents/triggers/:id/webhook` with
  `X-Knowledge-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`,
  `X-Knowledge-Timestamp` (Unix seconds, within 5 minutes of the server) and
  `X-Knowledge-Delivery` (a unique id). The answer is 202 with the run id, or
  with the reason nothing started. A wrong signature or a stale timestamp
  answers 401, a body over 64 KB answers 413, and a delivery id seen before
  starts nothing, however long after. The body reaches the model only as
  untrusted context. Rotating the secret stops the old one at once:
  `POST /v1/ai/agents/triggers/:id/rotate-secret` (admin). (#70)
- **Mention triggers.** Give a curator, reviewer or glossarist a "The agent is
  mentioned in a comment" trigger, and mentioning it in a page or merge-request
  discussion starts its background pass over that page instead of a chat
  reply. The run belongs to, and bills, the person who mentioned the agent. The
  agent's comment says it is working and, when the run ends, fills in with the
  run's summary, its first findings and a link to the run. If the run cannot
  start (one is already going over the page, the workspace is at its limit, the
  budget is spent), the comment says so. Only editors start runs this way;
  viewers, and every mention of an agent without such a trigger, get the
  ordinary reply as before. (#70)
- A **Digest** agent summarises what changed since its last successful run,
  or over the last 7 days if it has none (31 days at most). The summary
  covers new pages, pages whose default branch changed, merged changes and how
  many findings other agents reported. It lists only pages the whole workspace
  can open. The run proposes the digest as a page. **Create page** on its first
  finding publishes it as you, in the workspace's first project. Every link in
  that page points to a page that exists. The model writes only the summary and
  the highlights, and any link it invents is removed. Without a model
  configured, the digest still lists the changes. (#70)
- **Recipes** in **Settings → AI → Agents** set an agent up in one step:
  **Weekly digest** runs the digest on Mondays at 09:00. **Freshness sweep**
  runs the curator, told to look for stale pages, on Mondays at 08:00 and after
  every connector sync. **Glossary suggester** runs the glossarist on each
  merged page. Schedules use your browser's timezone. A recipe adds its schedule
  and triggers switched off, then opens the agent so you can turn them on. Its
  runs execute and bill as whoever turns them on. Applying a recipe again
  changes nothing: an agent that already has a schedule, or a trigger for the
  same event, keeps it. Route: `POST /v1/ai/agents/recipes/:recipe/apply`
  (admin). (#70)
- **Learnings**: teach an agent a correction and it is told it on later
  turns. **Teach agent** on an agent's reply in a page comment or review
  thread, **Dismiss → Remember why** on a finding, or **Settings → AI →
  Learnings** writes one, for one agent or every agent and optionally only in
  one project. What an editor writes is *proposed* and reaches no prompt; a
  workspace admin approves, rewords or archives it under **Learnings**. Active
  learnings are added to the agent's chat turns, its @mention replies and its
  background runs, newest first, up to `AGENT_LEARNINGS_MAX` per prompt.
  Routes: `GET /v1/ai/agents/learnings` (viewer), `POST /v1/ai/agents/learnings`
  (editor; `status: "active"` needs an admin), `PATCH
  /v1/ai/agents/learnings/:id` (admin). MCP gains
  `knowledge_list_agent_learnings` (active by default, open to read-only keys)
  and `knowledge_propose_agent_learning` (editor, proposes only). (#70)
- **Dismiss** a finding in **Settings → AI → Runs** when it is wrong or not
  worth acting on. It is hidden from the run (a switch shows dismissed ones),
  and the agent's next runs are given the titles of findings dismissed on its
  last ten runs and told not to report them again. Dismissing twice changes
  nothing and proposes at most one learning. Route:
  `POST /v1/ai/agents/runs/:id/findings/:index/dismiss` (editor). (#70)
- **Repository guidance files become skills.** After each successful sync of a
  codebase or Markdown/Git connector, its `AGENTS.md`, `CLAUDE.md`,
  `.cursorrules`, `.github/copilot-instructions.md` and `.cursor/rules/*.mdc`
  (at the repository root and at the connector's subdirectory) are imported
  into **Settings → AI → Skills** as **disabled** skills with no trigger words,
  marked with the connector and path. Nothing reaches a prompt until an admin
  enables one. A file over 64 KB is skipped, at most 20 are read, and one
  longer than a skill's 8 000-character budget is cut at a line break, which
  its description says. While a skill is disabled it follows the repository;
  once enabled, a commit never changes its text — the new version shows as
  **Upstream changed**, with a diff and **Accept upstream**. A file deleted
  upstream disables its skill and marks it **Removed upstream**. The connector
  page has an **Agent guidance** card with **Import now**. Routes:
  `POST /v1/connectors/:id/guidance/import` and
  `POST /v1/ai/skills/:id/accept-upstream` (both admin). (#70)
- `GET /v1/ai/agents/choices` takes `scope=all`, which names every agent in the
  workspace (still names and descriptions only, still open to viewers). The
  default is unchanged, so the composer and chat-bot pickers offer the same
  agents as before. With it, a learning for the curator or the digest, and a
  mention reply from a background agent, show the agent's name rather than its
  key, and **Teach agent** offers every agent. Triggers, recipes, learnings and
  repository guidance are written up in `docs/features/49-agent-triggers.md`.
  (#70)

### Changed

- Deleting a connector, or switching its access mirroring off, now turns the
  access it mirrored into ordinary grants and groups that admins can edit.
  Pages it restricted stay restricted. (#76)
- Assigning a merge-request reviewer who cannot open the page now answers 409
  with `details.reason = access.usersWithoutView` and the user ids. (#76)
- Creating a page under a parent now needs edit on that parent, or on the
  project for a top-level page, from `POST /v1/documents`, MCP
  `knowledge_create_document` and the assistant. In a workspace without
  restrictions every editor still has it. (#76)
- In a workspace with restricted pages, agents (curator, reviewer, glossarist,
  cartographer, archaeologist, surveyor, sentinel) no longer read them, even
  when an admin owns the run. A report on a restricted page is not judged by
  the sentinel: its run fails and the report returns to `open` for a person
  with access. (#76)

- Deleting a custom agent or a skill now asks for confirmation first. For a
  skill imported from a repository, the confirmation says it comes back,
  disabled, on the next sync. (#70)

### Fixed

- The **Direction** row on a connector's page showed a raw message key
  (`connectors.directionPull in`) instead of the direction. (#70)
- Search no longer returns hits from pages that were deleted. Their chunks
  could stay behind in ArcadeDB or OpenSearch and came back titled
  "(unknown)", often ranked above the page actually asked for; on the demo
  workspace, a page's own title found it first 0 times in 30. Only readers who
  had a restricted page hidden from them were spared, so results also differed
  by who was asking. Those hits are now dropped for everyone, in graph
  expansion too, and the same 30 titles find their page first 19 times. (#76)

### Operations

- Migration `20261025100000_ai_skill_repo_source` adds nullable provenance
  columns to `ai_skills` (plus `source`, defaulting to `manual`) and a unique
  index on (workspace, connector, path); the previous image runs against it
  unchanged. If the code is rolled back, imported skills stay as ordinary
  skills and stop following their repository. The import runs in the **API**
  after it hears a sync finish on the Redis bus, which does not redeliver:
  a sync that finishes while the API is down is read on the next sync or by
  **Import now**. Each import downloads the repository archive once more. One
  more optional setting, `REPO_GUIDANCE_IMPORT_ENABLED` (true), turns the
  after-sync import off; **Import now** still works.
- Migration `20261024100000_agent_learnings` only adds the `agent_learnings`
  table, so the previous image runs against it unchanged. A dismissal is
  written into the existing `agent_runs.findings` JSON. If the code is rolled
  back, learnings stop reaching prompts and dismissed findings show again, and
  both return when the release is restored. One more optional setting,
  `AGENT_LEARNINGS_MAX` (20): active learnings one prompt takes; `0` turns them
  off.
- Agent triggers are off server-wide until `AGENT_TRIGGERS_ENABLED=true` is set
  **for both the API and the worker**: the worker hears bus events, the API
  serves the webhook route (404 while off) and starts mention runs (mentions
  get the ordinary reply while off). The trigger editor says when it is off.
  A webhook secret is stored encrypted, so creating one needs
  `SETTINGS_ENCRYPTION_KEY`; without it the button answers 409. Two more
  optional settings: `AGENT_WEBHOOK_MAX_BYTES` (65536), the largest delivery
  accepted, and `AGENT_WEBHOOK_TOLERANCE_SECONDS` (300), how far a delivery's
  timestamp may be from the server clock. Two more optional
  settings: `AGENT_TRIGGER_MAX_ACTIVE` (5), the triggered runs one workspace
  may have in flight before further events are skipped, and
  `AGENT_TRIGGER_COOLDOWN_MINUTES` (60), the cooldown a new trigger starts
  with. Triggers hear the Redis event bus, which does not redeliver: an event
  published while the worker is down starts no run.
- Migration `20261023100000_agent_trigger_webhooks` adds a nullable
  `agent_triggers.webhook_secret`, widens the `agent_triggers_event_check`
  constraint to the two new events, and adds a nullable, indexed
  `agent_run_id` to `document_comments` and `merge_request_comments`. Nothing
  is backfilled. If the code is rolled back, webhook and mention triggers stop
  firing (the previous image ignores rows it does not know), and an agent reply
  still waiting on a run when that happens is timed out by the old 10-minute
  sweep.
- Migration `20261022100000_agent_triggers` adds the `agent_triggers` table,
  two nullable columns on `agent_runs` (`trigger_id`, `subject_key`) and two
  indexes. Nothing is backfilled and the previous image ignores all of it. If
  the code is rolled back, triggers stop firing; runs they started stay
  listed, with a trigger label the old web shows as a raw key.
- Migration `20261021100000_agent_schedule_time_of_day` adds five nullable
  columns to `ai_agents` (`schedule_kind`, `schedule_time`,
  `schedule_weekdays`, `schedule_timezone`, `schedule_changed_at`) and two
  CHECK constraints. Nothing is backfilled: a null kind reads as an interval.
  The previous image ignores the columns. If the code is rolled back, daily
  and weekly schedules stop firing, and interval schedules keep running.
- One more optional setting, `CONNECTOR_ACL_SYNC_DEFAULT_MIN` (60): minutes
  between access syncs for a connector that mirrors permissions and sets no
  interval of its own. Access syncs run from the worker's existing connector
  schedule tick, so `CONNECTOR_SCHEDULE_ENABLED=false` stops them too.
- Migration `20261020100000_connector_acl` adds four columns to `connectors`
  (`acl_mode` defaults to `off`), two to `connector_links`, one to
  `connector_run_items`, an index on `access_grants.connector_id` and the
  `external_identities` table. All are additive; the previous image ignores
  them. Rolling the code back leaves mirrored restrictions in place but stops
  refreshing them, and the rolled-back Access dialog would save mirrored grants
  back as manual ones.
- Two more optional settings: `ACL_CACHE_TTL_MS` (5000), how long a live
  connection trusts the page visibility it computed before reading it again
  (an `acl.changed` event clears it at once), and `ACCESS_REQUEST_TTL_DAYS`
  (30). The API runs a five-minute tick that expires pending requests and
  tells each requester.
- Migration `20261019100000_access_requests` only adds the `access_requests`
  table, with a partial unique index allowing one pending request per person
  and page. The previous image never reads it and runs against it unchanged.
  Rolling the code back leaves pending requests unanswered until the release
  is restored.
- Five new settings, all optional: `ACL_DENY_LIST_MAX` (5000),
  `SEARCH_ACL_OVERFETCH` (5), `SEARCH_ACL_MAX_FETCH` (500),
  `ACL_RESTAMP_TICK_MS` (30000) and `ACL_RESTAMP_BATCH` (200). The worker now
  runs a re-stamp tick that copies each page's restrictions onto its chunks in
  ArcadeDB and OpenSearch, without re-embedding anything. With
  `FULLTEXT_PROVIDER=opensearch`, the first search or indexing after the
  deploy adds two fields (`aclNodes`, `aclRestricted`) to the existing index
  mapping. That change is additive, needs no reindex, and the previous image
  ignores the fields. Search always decides visibility from Postgres, so a
  stamp that lags only costs recall, and only past `ACL_DENY_LIST_MAX` hidden
  pages.
- Migration `20261018100000_page_restrictions` adds the `access_grants` table
  and new columns with defaults on `documents` (`restricted`, `restricted_by`,
  `acl_version`, `acl_stamped_version`) and `projects` (`restricted`), plus a
  GIN index on `documents.restricted_by`. Nothing is restricted when it runs,
  so no backfill is needed and the previous image runs against it unchanged.
  **Rolling the code back does not roll restrictions back with it:** the
  previous image ignores these columns, so every restricted page becomes
  readable by every member (and guests are refused everywhere) until the
  release is restored.
- Migration `20261017100000_user_groups` only adds two tables
  (`user_groups`, `user_group_members`), so the previous image runs against it
  unchanged. `workspace_members.role` now also accepts `guest`. That column has
  no constraint, so no DDL is needed for it. Rolling the code back leaves any
  guest members refused everywhere, which is the same as what they can open now.

## [0.21.1] — 2026-10-14

### Changed

- **Connect AI** now lives inside **Settings → AI**, and the AI settings tabs
  have become a section rail beside the page: Connect AI (yours, open to every
  role), then the assistant's configuration, quality and activity sections. Each
  section has its own address, `/settings/ai/<section>`, so a link can open one
  directly. Bare `/settings/ai` opens Connect AI. Old links keep working:
  `/settings/connect` (printed in every agent skill already handed out) and
  `/settings/ai?tab=<x>` redirect to the matching section. On a phone the rail
  becomes one scrollable row above the section. (#182)

## [0.21.0] — 2026-10-14

### Added

- A workspace can answer questions in Telegram. An admin connects a bot under
  **Settings → Chat bots** by pasting its BotFather token; the token is checked
  with Telegram, stored encrypted and never shown again, and the bot's webhook
  is set to this server. Anyone who messages the bot privately gets a one-time
  link that ties their Telegram account to their account here; after that every
  answer runs as them, with exactly their access, cites the pages it used as
  links, and is kept as a conversation in their **Assistant** history. A bot
  answers in a group only once a workspace admin binds it (`/bind` in the group,
  or by chat id in settings), and there only when mentioned unless the group is
  set otherwise; each group can be scoped to one project, use its own agent and
  reply in its own language. Linked accounts are listed under **Settings →
  Profile** with unlink. (#71)
- Chat-bot answers can be rated. Every answer in Telegram carries 👍 and 👎;
  a 👎 then offers the same reasons as the web app (wrong, out of date, wrong
  pages cited…). Votes are recorded as the person who pressed, so anyone in a
  group can rate an answer once they have linked their account, and they show
  up in the admin **Feedback** tab as the *chat bot* surface. (#71)
- An editor can save a chat-bot conversation. **💾 Save…** under an answer
  turns the questions and answers posted in that chat into a page draft — an
  empty page plus a merge request, so nothing is published until it is merged
  — or into a glossary term that stays switched off until an editor turns it
  on in **Settings → Glossary**. The draft is written as the person who
  pressed Save, links the pages the answers cited, and lands in the group's
  project (the workspace's first project from a private chat). (#71)
- A bound chat group can be told what changed. Under each group in
  **Settings → Chat bots → Notifications**, an admin picks what to report —
  new pages, page updates, merge requests opened or merged — in one project or
  the whole workspace, optionally only for pages with certain tags, and whether
  to post right away or as an hourly, 4-hourly or daily digest. Only titles and
  links are posted, never page content, and the links still ask readers to
  sign in. Edits on review branches are not reported until they merge, and
  each change is posted once, even across restarts. (#71)
- Chat bots also work in **Time**, T-Bank's corporate messenger. In
  **Settings → Chat bots → Connect a bot**, pick Time, give your Time server's
  address and the token of a bot created under Integrations → Bot accounts.
  Everything the Telegram bot does works there: cited answers as the linked
  person, account linking, 👍/👎, saving a conversation and channel
  notifications. In a channel the bot answers in the question's thread, and
  anything said in that thread afterwards is a follow-up. Commands are plain
  words (`help`, `new`, `bind`…) because Time keeps `/` for its own commands.
  Built against Time's documented API, not yet tried on a live Time server.
  (#71)

### Operations

- New env vars, all with defaults: `CHAT_ENABLED` (default `false` — chat bots
  answer nothing and the webhook returns 404 until it is `true`),
  `CHAT_ANSWER_TIMEOUT_SECONDS` (120), `CHAT_MAX_SOURCES` (5),
  `CHAT_LINK_CODE_TTL_MINUTES` (15), `CHAT_RATE_LIMIT_PER_USER_PER_MINUTE` (10)
  and `TELEGRAM_API_BASE_URL` (`https://api.telegram.org`; point it at a
  self-hosted Bot API server or proxy when this host cannot reach Telegram).
  Telegram delivers to `${API_PUBLIC_URL}/v1/chat/<id>/webhook`, which must be
  public HTTPS; bot tokens need `SETTINGS_ENCRYPTION_KEY`. (#71)
- Migration `20261014170000_chat_bots_core` only creates the six `chat_*`
  tables. The previous release ignores them, so a code rollback is safe. (#71)
- New env var `CHAT_CAPTURE_TIMEOUT_SECONDS` (default 300): a saved chat
  conversation still drafting after this long is failed and its "Drafting…"
  message says so. Migration `20261014190000_chat_captures` only creates the
  `chat_captures` table; a code rollback is safe. (#71)
- New env var `CHAT_DIGEST_TICK_MS` (default 60000, minimum 5000): how often
  chat notification rules are checked, so "right away" means within one tick.
  Migration `20261015100000_chat_subscriptions` only creates the
  `chat_subscriptions` table; a code rollback is safe. (#71)
- Time bots are heard over a websocket the API opens to each Time server, not
  a webhook: the API must be able to reach the Time server, and the Time server
  must reach `API_PUBLIC_URL` for the answer buttons to work. A message sent
  while that connection is down is not answered. Every API replica opens its
  own connection; Redis keeps them from replying twice. New env vars:
  `CHAT_ALLOW_PRIVATE_URLS` (default `false` — set it to `true` to allow a
  Time server on a private network, the usual in-house setup) and
  `CHAT_SOCKET_SYNC_MS` (15000: how soon a saved or switched-off Time bot is
  picked up). Migration `20261016100000_chat_time` adds
  `chat_integrations.server_url` (default `''`), widens the bot-account unique
  to include it, and adds `chat_answers.thread_id`; the previous release
  ignores both columns and the unique behaves the same for Telegram, so a code
  rollback is safe. (#71)
- On knowledge.hrustalq.dev, chat bots ship switched off (`CHAT_ENABLED=false`
  in the `production` environment). `api.telegram.org` cannot be reached from
  that host. Before turning Telegram on there, point `TELEGRAM_API_BASE_URL`
  at a Bot API server or proxy the host can reach. `.env.production.example`
  now has a chat section that says so, and `.env.example` sets
  `API_PUBLIC_URL`, the base of every webhook URL. (#189)

## [0.20.0] — 2026-10-14

### Added

- A codebase connector can produce a repo wiki. Set **Repo wiki** to on, and
  the overview gains Architecture and Data flow pages, plus an optional Public
  API page, beside the module pages. A `.knowledge/wiki.yml` file in the
  repository chooses which sections exist, which paths are read
  (`include`/`exclude`), module titles, the flows to trace and the effort. At
  effort `low` the wiki makes no AI calls. An invalid file never fails a sync:
  the defaults apply and the run warns, naming what was wrong. Each page is
  re-derived only when its own inputs change, so a function body edited in one
  module re-derives that module's page and nothing else. (#72)
- Repo wiki pages carry Mermaid diagrams:
  - Architecture draws how the modules import each other.
  - Each module page draws its exported types with inheritance.
  - Data flow draws each flow as a sequence diagram (effort `medium` and up).
  At effort `high`, each page is written after the model reads the code with
  the code tools. Diagrams are built by the server from parsed facts. The model
  never writes diagram syntax. A diagram that fails the safety check is left
  out with a warning, and the page still syncs. (#72)
- A repo wiki can regenerate on push. With **Regenerate on push** on, a push
  to the connector's branch, or a published release, queues one sync after a
  short wait. Pushes during that wait fold into the same sync. Only the pages
  whose inputs changed are re-derived. With **Wiki delivery** set to
  merge request, a regenerated page arrives as a merge request by the
  connector's owner instead of changing the page, and a newer regeneration
  closes the older merge request. (#72)
- A codebase connector can write release notes. Turn on **Release notes** to
  get a Releases page, an Unreleased page, and one page per recent version
  tag, built from commits and merged pull or merge requests. Breaking changes
  are confirmed by a conventional commit (`feat!:`, `BREAKING CHANGE:`), by a
  label on the request, or by an exported function or type that was removed
  or changed shape. Each confirmed change names its source. At effort `medium`
  and up, a summary opens each page, and changes the model only suspects are
  listed apart as "Possibly breaking". A published release's page is never
  regenerated. (#72)
- The connector page has a **Wiki** tab and a **Releases** tab.
  - The Wiki tab lists the wiki's pages, marks which are stale or waiting in a
    merge request, and shows how `.knowledge/wiki.yml` is steering the wiki:
    validation errors, and the effort asked beside the effort the server
    allows. Editors can regenerate one section or the whole wiki, and can force
    a full rewrite.
  - The Releases tab lists each release with its confirmed and suspected
    breaking counts.
  New API routes `GET /v1/connectors/:id/wiki`,
  `POST /v1/connectors/:id/wiki/regenerate` and `GET /v1/connectors/:id/releases`.
  New MCP tools `knowledge_repo_wiki` (read) and `knowledge_regenerate_wiki`
  (write, not offered to read-only keys). (#72)
- The archaeologist no longer treats a repo wiki's file listings as
  documentation. It still proposes undocumented logic files below the wiki's
  module pages. (#72)

### Fixed

- A codebase connector no longer reports every updated page as a conflict.
  Pages that carry frontmatter, which is every page this connector writes,
  were always read as edited here, so with the default conflict policy each
  update opened a merge request instead of updating the page. (#72)

### Operations

- Every `codebase` connector re-derives all of its pages once, on its first sync
  after this release. The generator version moved to 2, so this happens with
  the wiki off too. Expect one narration call per page for each such connector.
  Connectors with no owner, or with no AI configured, make no calls.
- New env vars, both with defaults: `WIKI_MAX_EFFORT` (`medium`), the most
  effort any repository or connector may ask for, and `WIKI_DIAGRAM_MAX_NODES`
  (`40`). Both are ceilings. A repository can ask for less, never more.
  `WIKI_HIGH_EFFORT_MAX_TOOL_CALLS` (`24`) caps the code-tool calls one wiki
  page may make at effort `high`. The new usage operation `wiki` shows the
  wiki's extra spend separately from `codebase`. `WIKI_PUSH_DEBOUNCE_MS`
  (`120000`) is how long a push-triggered sync waits for more pushes.
  `CHANGELOG_MAX_RELEASES` (`20`) is how many tags a first sync generates
  release notes for, and `CHANGELOG_MAX_COMMITS_PER_RELEASE` (`500`) caps the
  commits read per release. A new usage operation, `changelog`, records
  release-note spend.
- Migration `20261014150000_repo_wiki_conflict_reason` adds
  `connector_conflicts.reason` (`NOT NULL DEFAULT 'conflict'`) and an index.
  It is additive, and the previous release ignores the column, so it survives
  a rollback by retag.
- Push regeneration through the GitHub App needs **Contents: read** and the
  **push** event on the App. The connector's GitHub access card lists both
  under "repo wiki on push" while the setting is on. Release notes need
  **Pull requests: read** and the **release** event, listed under "release
  notes". Each release also downloads the previous tag's archive once to
  compare the exported API.

## [0.19.1] — 2026-10-14

### Changed

- Search in production ranks by content. Keyword matches (BM25 over
  OpenSearch) are now fused with the vector results. The vector leg runs on
  the stub embedder there, so until now nothing ranked by what a page says.
  PDF export is offered in production as well. (#169)

### Fixed

- Downloads from object storage work again in production: export files
  (PDF, ZIP, HTML), page attachments and avatars. Each one failed with
  `403 SignatureDoesNotMatch`, because Tailscale Funnel replaces the
  `X-Forwarded-Host` that Caddy used to rebuild the host the URL was signed
  for. Caddy now sets that host from configuration. (#167)

### Operations

- `docker-compose.prod.yml` gains an opt-in `opensearch` service (single node,
  no published port, 512 MB heap in a 1.5 GB container, volume `osdata`).
  `.env.production.example` now requires `COMPOSE_PROFILES=gotenberg,opensearch`,
  `GOTENBERG_URL`, `FULLTEXT_PROVIDER=opensearch` and `OPENSEARCH_URL`. All four
  are already set in the `production` environment, and the deploy refuses an
  environment without them. While OpenSearch is down, search fails, because
  its leg is awaited. Pages indexed before it was turned on need
  `POST /v1/ingestion/reindex`. On a rollback the extra service keeps running
  and the previous release ignores it. To turn it off, set
  `FULLTEXT_PROVIDER=none` and drop `opensearch` from `COMPOSE_PROFILES`. (#169)
- The `caddy` service takes a new optional variable, `S3_PUBLIC_HOST`. It must
  be `S3_PUBLIC_ENDPOINT`'s host; `docker-compose.prod.yml` defaults it to
  `knowledge.hrustalq.dev`, so production needs no change. Set it in the
  `production` environment only if `S3_PUBLIC_ENDPOINT` moves. (#167)

## [0.19.0] — 2026-10-14

### Added

- Published sites can answer on their own hostnames. An admin adds a domain on
  the site's new **Domains** tab, which shows the CNAME and TXT records to
  create; the domain is served once the TXT record proves control, checked on
  demand and automatically for a week. The first verified domain becomes the
  site's canonical address in links, the sitemap and llms.txt. (#77, #156)
- Published sites serve `sitemap.xml` (the default version, absolute canonical
  URLs), `robots.txt` (everything disallowed when the site is not indexable),
  `llms.txt` and `llms-full.txt` per version, and every page as markdown at
  `<page>.md`, all built from the published snapshot only. Pages link their
  copies in other versions with `<link rel="alternate">`, and the version
  switcher goes straight to them. (#77, #156)
- A site build whose job was lost (a Redis flush, a worker that died between
  jobs) is requeued after 15 minutes instead of saying "building" until the
  next restart. (#77, #156)
- Published sites have search. A search button in the site header (or `/`,
  ⌘K / Ctrl+K) opens the same side sheet the app uses, and results come only
  from the pages of the version being read, at the revisions it shows: a
  draft, an unpublished page or another version's page is never returned.
  English and Russian words match across word forms (`install` finds
  "Installing", `установк` finds «Установка»). (#77, #157)
- Published site pages render once and are then served from a cache in the web
  process for as long as the API confirms nothing they show has changed.
  Unpublishing still ends a site on the very next request. A large page went
  from about 105 ms to about 21 ms on the dev stack. (#77, #157)
- **Export.** A page, a page with its subpages, or a whole project can be
  exported from the page's ⋯ menu or the project page by anyone who can read
  it, and from the page tree's row menu by editors. Three formats: **Markdown (ZIP)**, the
  sources with their frontmatter, attachments and a `manifest.json` describing
  the tree; an **HTML site (ZIP)** that opens offline, with a contents page,
  breadcrumbs, subpages and previous/next, and images included; and **PDF**,
  one document with a page break per page and diagrams drawn, where the
  deployment has Gotenberg (images hosted elsewhere are left out of a PDF). Exports run in the background: the exports page
  (Settings → Exports) shows progress, the inbox says when one is ready, and
  the file can be downloaded for 72 hours. An export of more than 500 pages is
  refused before it starts. DOCX is not offered: Gotenberg converts only to
  PDF. MCP gains `knowledge_export` and `knowledge_get_export`, both open to
  read-only keys. (#77, #158)
- **Site audiences.** An admin can keep parts of a published site from the
  public on the site's new **Audience** tab. A rule on a page covers it and
  everything below it: **Members** pages are for workspace members, who sign
  in to the site through the app; **Visitors** pages are also open to people
  your own backend signs in, by sending them to any site page with
  `?jwt_token=` holding an HS256 JWT signed with the site's secret, optionally
  only when its claims match (`plan=pro`). Rules apply to every version at once,
  frozen ones included, with no rebuild. A reader who may not see a page gets
  no sign it exists: it is missing from the nav and search, and its address,
  attachments and `.md` answer 404. `sitemap.xml` and `llms.txt` list public
  pages only. Replacing the visitor secret signs every visitor out. (#77, #159)
- **Ask on published sites.** An admin can let a site answer questions from
  its own pages on the site's new **Ask** tab. Readers get an Ask button beside
  search, and other sites can embed a widget with
  `<script src="<site>/widget.js" async></script>`, but only on the origins
  the admin lists (anywhere else, the browser refuses it). Answers are drawn
  only from the published pages the reader may see, at the revisions the
  version shows; every sentence links to the page it rests on. Each site has
  a daily budget of answers; past it, visitors are told to come back tomorrow.
  Usage shows in AI usage as **Site Ask**, labelled with the site. (#77, #160)

### Fixed

- The web server no longer exits when the first page it renders after a
  start is a share link or a published-site page. Until it had rendered a
  page of the app itself, any reader opening a share or site page brought the
  whole web container down for the time it took to restart, app included.
  (#77, #163)

### Operations

- Migration `20261013180000_site_domains` adds the `site_domains` table and
  `site_versions.updated_at` (with a default). Expand-only: the previous
  release runs against it, and a rollback needs no down migration. (#156)
- New env vars, both with defaults: `SITE_CUSTOM_DOMAINS` (default `true`;
  whether custom hostnames are routed at all) and
  `PUBLISHING_SWEEP_INTERVAL_MS` (default `60000`). (#156)
- **Production: set `SITE_CUSTOM_DOMAINS=false`** in the `production`
  environment. Its TLS ends at the Cloudflare Worker in front of Tailscale
  Funnel, so Caddy cannot issue certificates for other hosts, and a domain
  admins could verify would never open. `.env.production.example` now lists it,
  so the deploy fails until it is set. The production `Caddyfile` is unchanged. (#156)
- An install where Caddy faces the internet can serve base-domain and custom
  hosts over HTTPS with `Caddyfile.sites.example` (on-demand TLS whose `ask` is
  `GET /v1/public/domains/allow`), plus a wildcard DNS record for
  `*.<PUBLISH_BASE_DOMAIN>`. Each custom domain needs two records on its
  owner's side, both shown on the Domains tab: a CNAME to this server and a
  TXT record at `_knowledge.<hostname>`. The API reads the TXT record through
  its own resolver, so the API container needs outbound DNS. Caddy asks for no
  certificate until that record has been seen. (#156)
- The web container now reads `WEB_BASE_URL` (passed by
  `docker-compose.prod.yml`): its own host is never looked up as a site's.
  Any other host is asked of the API once a minute. (#156)
- Migration `20261013210000_site_search` adds `search_headings`,
  `search_body` (both defaulted) and a nullable `search_vector` to
  `site_version_pages`. Expand-only: the previous release runs against it,
  and a rollback needs no down migration. Snapshots built before it are
  searchable once the worker has filled them from their pinned revisions,
  which it does by itself at startup (one object read per page, a few seconds
  for a few hundred pages). No version is rebuilt for it. (#157)
- New web env var `SITE_RENDER_CACHE_MB` (default `32`; `0` turns the render
  cache off), passed by `docker-compose.prod.yml`. Production needs no change. (#157)
- Migration `20261013230000_export_jobs` adds the `export_jobs` table.
  Expand-only: the previous release never reads it, and a rollback needs no
  down migration. Finished files live in MinIO under
  `workspaces/{ws}/exports/{id}/` and are deleted after `EXPORT_TTL_HOURS` by
  the API. (#158)
- New env vars, all with defaults: `GOTENBERG_URL` (empty: no PDF),
  `WEB_INTERNAL_URL` (`http://localhost:5173`), `EXPORT_MAX_PAGES` (`500`),
  `EXPORT_MAX_BYTES` (256 MB), `EXPORT_TTL_HOURS` (`72`),
  `EXPORT_CONCURRENCY` (`2`) and `EXPORT_TIMEOUT_MS` (10 minutes).
  `docker-compose.prod.yml` sets `WEB_INTERNAL_URL=http://web:5173` on the
  worker, so production needs no change for ZIP and HTML. (#158)
- The web server has a new route, `POST /_internal/export/render`, that the
  worker calls to render an export. It answers only a peer on the internal
  network whose request carries no `X-Forwarded-*` header — Caddy always adds
  one — so it is unreachable through the front proxy. (#158)
- **PDF is opt-in.** `docker compose --profile gotenberg up -d gotenberg` and
  `GOTENBERG_URL=http://gotenberg:3000` (in dev: `make infra-up-gotenberg` and
  `http://localhost:3100`). The image is about 1 GB. Its Chromium is started
  with `--chromium-allow-list=^file:///tmp/.*`: keep that flag on any
  Gotenberg you point at, or a page that embeds an internal URL gets it
  fetched from inside your network and printed into the PDF. (#158)
- Migration `20261014090000_site_audiences` adds the `site_audience_rules`
  table, `audience` (default `'public'`) and nullable `audience_claims` to
  `site_version_pages`, and two nullable visitor-secret columns to
  `published_sites`. Expand-only: the previous release runs against it and
  shows every page, as it always did, so a rollback needs no down migration —
  but **a rollback makes restricted pages public again** until the release
  that reads the rules is back. (#159)
- New env var `SITE_VISITOR_TTL_MIN` (default `1440`): how long a site
  sign-in lasts. Visitor sign-in also needs `SETTINGS_ENCRYPTION_KEY` (already
  set in production) to store the site's secret; without it the Audience tab
  says so and members-only rules still work. (#159)
- Migration `20261014120000_site_ask` adds `ask_enabled` (default `false`),
  nullable `ask_daily_budget` and `embed_origins` (default empty) to
  `published_sites`. Expand-only: the previous release ignores them, and a
  rollback needs no down migration (the widget and Ask button simply go away). (#160)
- New env vars, both with defaults: `PUBLIC_ASK_DAILY_BUDGET` (`200`; the most
  answers one site may give a day, a ceiling over each site's own setting; `0`
  turns Ask off everywhere) and `PUBLIC_ASK_RATE_PER_MIN` (`6`, per address).
  Ask answers with the workspace's chat model and counts against its AI
  budget; a workspace without a model says "unavailable". (#160)

## [0.18.0] — 2026-10-13

### Added

- **Page templates, API and MCP.** A workspace now has a template gallery: seven
  built-ins in English and Russian (ADR, RFC, runbook, postmortem, API
  specification, use case, domain entity) plus its own templates, scoped to the
  workspace or one project, each with an immutable version history. A template
  carries a default category, tags and typed relations, so a page created from
  it is linked into the graph from its first revision. Placeholders
  (`{{number}}`, `{{component}}`…) are declared and typed (text, date, user,
  page, entity); anything undeclared stays literal. `GET/POST/PATCH
  /v1/templates`, `POST /v1/templates/render`, and `POST /v1/documents` accepts
  a `template` to start from, recording `templateRef`/`templateVersion` on the
  page. Built-ins can be customised, hidden or reset per workspace; workspace-wide
  templates need `admin`, project ones `editor`. MCP gains
  `knowledge_list_templates` and `knowledge_get_template`, and
  `knowledge_create_document` takes `templateRef` + `values` instead of
  `content`. The gallery and editor UI follow in later releases. (#146)
- **New page from a template.** The page tree's `+` has a chevron beside it
  with "From template…", a page's ⋯ menu gains "New child page" and "New child
  page from template…", and an empty tree offers the gallery too. The gallery
  groups the project's, the workspace's and the built-in templates, asks for
  the placeholders a template declares (people and pages are picked, not
  typed), previews the filled-in skeleton, and opens the editor on it with the
  parent already set. Nothing is saved until the author publishes; the page
  then records which template and version it came from and shows a "From
  template" chip. Unpublished edits keep that provenance across a reload.
  `POST /v1/documents` gains `template.provenanceOnly` for clients that upload
  the body themselves, as the editor does. (#147)
- **Templates in settings, `/template` in the editor, and Save as template.**
  Settings → Templates lists every template the project can see, archived ones
  and hidden built-ins included, with each one's shape and version history (a
  diff between any two versions). Templates are written with a form and the
  rich editor rather than YAML: placeholders, title pattern, the tags and
  relations pages inherit, and instructions for the assistant. A built-in can
  be customised (its versions continue from the shipped one), hidden, shown
  again or reset; a custom template can be archived and restored. Typing
  `/template` (or `/шаблон`) in a page inserts a template's skeleton at the
  cursor and adds its tags and relations to the page. "Save as template" in a
  page's ⋯ menu, in the document view and in the editor, turns the page into a
  template, finding its `{{placeholders}}`. Controls follow the API's rule:
  project templates are editors', workspace-wide and built-in ones admins'.
  Template details from the API now include `frontmatter`, so an editor can
  keep keys it does not model. (#148)
- **Fill a template with AI.** The template gallery has an optional "Describe
  the page for AI" box. With it filled in, the editor opens on the skeleton
  with the assistant beside it, and the description goes in as the first
  message. The assistant fills the template's sections as suggestions you keep
  or discard, keeps the headings, and writes `TODO:` where it has nothing to go
  on. Nothing is saved until you publish. While a new page started from a
  template is still unpublished, every assistant turn knows which template it
  came from. The template's instructions for the assistant are passed as
  workspace-written hints, not as rules the model must follow. The assistant
  also gains `list_templates` and `get_template` tools, and its
  `create_document` tool takes a `templateRef` and placeholder `values` instead
  of markdown. Built-in agents get the two read tools; a custom agent has to
  add them to its tool list. `POST /v1/assistant/threads/:id/messages` accepts
  `draft.template` (`{ ref, version }`).
- **Templates in workflows and import.** A workflow's drafting step can name
  a page template ("Written into template" in the step panel). Its drafts then
  keep the template's headings, fill its placeholders from the source page or
  say `TODO:`, and carry the template's tags and relations. A page approved
  from such a draft records the template and version it was written against.
  The "Break a page into its parts" and "Entity → use cases → contracts and
  screens" starter patterns now use the built-in use-case and API-spec
  templates. Saving a
  workflow whose step names a template that does not exist in the workspace,
  or that is archived, is refused with the step marked; workflows saved before
  a template was archived keep running. The import review step has a Template
  field: the imported text is kept as is, and the page gets the template's
  category, tags and relations. "Save as template instead" turns the reviewed
  text into a template and drops the import. Images from the original are not
  carried into the template. `PATCH`/`POST /v1/workflows` accept
  `produces.templateRef` on a step, and `POST /v1/imports/:id/submit` accepts
  `templateRef`.

- **Public share links.** An editor can hand a page, or a page and everything
  under it, to someone who never signs in: **Share** in the page header creates
  a read-only link with an optional password and an expiry (1, 7 or 30 days, or
  never). The link opens a server-rendered copy of the page at `/s/<token>`.
  The text is in the HTML before any script runs; comments, history, authors
  and frontmatter are not served. Revoking a link, its expiry, or switching
  sharing off ends access on the very next request. Anything outside the shared
  page or subtree, including an attachment of another page, answers 404, the
  same as a link that does not exist. Sharing is **off** until a workspace
  admin turns it on in **Settings → Publishing**, which also lists every link
  in the workspace. A link that never expires needs a password unless the
  admin allows otherwise. Over MCP, `knowledge_share_page` creates one (editor;
  hidden from read-only keys). (#77)
- **Published docs sites.** A project, or one page and everything under it,
  can now be published as a read-only docs site that anyone with the address
  can read: a page tree, an "On this page" outline, previous/next links and the
  project's avatar as its logo, rendered on the server so the text is there
  without JavaScript. Set it up from **Project settings → Published site**
  (admins): pick the address, then the accent colour, font, header links and
  footer, and publish. Sites are served at `/pub/<address>`, or at
  `<address>.<PUBLISH_BASE_DOMAIN>` when a base domain is configured. Readers
  see a snapshot, never a branch head: only indexed revisions are published,
  the "Latest" version rebuilds itself shortly after a page changes, and a
  version you add can be frozen as it is now (`v1.0`) or follow a named branch,
  with a version switcher that keeps the reader on the same page. A page whose
  latest change failed to index keeps showing its previous revision, and the
  version lists it as a warning. Unpublishing, or turning sites off, takes a
  site down on the next request. Like share links, sites are **off** until a
  workspace admin allows them in **Settings → Publishing**. Search, sitemap,
  `llms.txt` and custom domains come with the next phase. (#77)

### Fixed

- **File uploads and attachments work in production.** Every upload (editor
  attachments, user and project avatars, the import wizard) and every attached
  image or avatar was handed a URL at `http://minio:9000`, a host only the
  server can reach, so the browser's upload failed and images did not render.
  Those URLs are now signed for the public site, which proxies the bucket's
  path to object storage; the storage console and admin API stay private.
  (#144)

### Operations

- New optional env var `S3_PUBLIC_ENDPOINT` (empty by default = today's
  behaviour, presigning against `S3_ENDPOINT`). Production needs the variable
  `S3_PUBLIC_ENDPOINT=https://knowledge.hrustalq.dev` in the GitHub
  `production` environment **before** the tag is pushed — deploy refuses to run
  without it, since `.env.production.example` now gives it a value. The
  `Caddyfile` routes `/<S3_BUCKET>/*` to MinIO and restores the `Host` from
  `X-Forwarded-Host`, which the `knowledge-edge` Worker sets; the caddy
  container is recreated by this deploy. No migration. (#144)
- Migration `20261012180000_page_templates` is expand-only: two new tables
  (`page_templates`, `page_template_versions`) and two nullable columns on
  `documents` (`template_ref`, `template_version`). The previous image runs
  against it unchanged, so a code rollback needs no database step. No new env
  vars; built-in templates live in code and are never seeded. (#146)
- Share links (#77): migration `20261012200000_share_links` is expand-only
  (two new tables, `share_links` and `publishing_settings`), so a code rollback
  needs no database step. New env vars, all with defaults, none required:
  `PUBLIC_SHARING_ENABLED` (`true`; the ceiling over the workspace switch,
  which itself defaults to off), `SHARE_LINK_MAX_TTL_DAYS` (`0` = no cap),
  `SHARE_UNLOCK_TTL_MIN` (`720`), `PUBLIC_RATE_LIMIT_PER_MIN` (`120` per IP)
  and `PUBLIC_UNLOCK_ATTEMPTS_PER_15MIN` (`10` per IP and link). Rate limits
  and password sessions are kept in the existing Redis. Without
  `SETTINGS_ENCRYPTION_KEY` a link is shown once, at creation, and cannot be
  copied again later. The web image gains `jsdom` (server-side sanitising of
  public pages) and a second built app, `reader.html`; no Caddyfile change,
  since `/s/*` already reaches the web container and `/api/*` the API.
- Published sites (#77): migration `20261013090000_published_sites` is
  expand-only (three new tables, `published_sites`, `site_versions` and
  `site_version_pages`, and one nullable column,
  `publishing_settings.allow_public_sites`), so a code rollback needs no
  database step; a rolled-back image simply serves no sites. New env vars, all
  with defaults, none required: `PUBLIC_SITES_ENABLED` (`true`; the ceiling
  over the workspace switch, which defaults to off), `PUBLISH_BASE_DOMAIN`
  (empty = path mode, `/pub/<slug>`), `SITE_BUILD_DEBOUNCE_MS` (`30000`) and
  `SITE_MAX_PAGES` (`2000`). Builds run in the worker on a new BullMQ queue,
  `site-build`, in the existing Redis. `docker-compose.prod.yml` now passes
  `PUBLISH_BASE_DOMAIN` to the web container as well. Leave it empty in
  production for now: a subdomain needs the Caddy on-demand TLS block that
  ships with the next phase, and `/pub/*` already reaches the web container
  with no Caddyfile change.

## [0.17.0] — 2026-10-12

### Added

- **SMTP login as two settings.** `MAIL_SMTP_USER` and `MAIL_SMTP_PASS` carry
  the relay credentials verbatim — no URL-encoding — beside a credential-free
  `MAIL_SMTP_URL` such as `smtps://smtp.timeweb.ru:465`, so the URL can be an
  ordinary variable and only the password a secret. The old `user:pass@` URL
  form still works; setting both refuses to boot. (#140)

### Operations

- New optional env vars `MAIL_SMTP_USER`, `MAIL_SMTP_PASS` (both empty by
  default). To send through Timeweb: variable `MAIL_SMTP_URL=smtps://smtp.timeweb.ru:465`,
  variable `MAIL_SMTP_USER`, secret `MAIL_SMTP_PASS`, variable
  `MAIL_TRANSPORT=smtp`, then deploy. `scripts/env-to-github.mjs` now treats a
  name ending `_PASS` as a secret. (#140)

## [0.16.0] — 2026-10-12

### Added

- **The platform sends email.** Signup mails a link to confirm the address,
  `forgot-password` mails the reset link instead of writing it to the API log,
  and every password change (reset, change-password, an admin's override) sends
  a "your password was changed" notice. Messages are in the recipient's
  language (en/ru). New routes: `POST /v1/auth/verify-email` (public, takes the
  `kv_` token) and `POST /v1/auth/resend-verification` (at most once a minute).
  `GET /v1/me` reports `emailVerified` and `emailVerificationRequired`; an
  unconfirmed account sees a banner with a Resend button. (#132)
- **Admin-created accounts get an invite.** Creating a user in Settings › Access
  without a password now emails them a link to set one (valid
  `AUTH_INVITE_TTL_HOURS`, 72 by default) instead of leaving them to discover
  password reset. The accounts list marks unconfirmed addresses. (#132)
- **Mentions, review requests and assignments reach your inbox by email.** One
  email per notification, however much activity later piles onto it, and only
  to a confirmed address; watch-driven page edits stay in the app. Turn it off
  per workspace under Notifications › Settings › Email. (#132)
- **Optionally require a confirmed address.** With
  `AUTH_REQUIRE_VERIFIED_EMAIL=true`, an unconfirmed login session can only see
  who it is, change its language, sign out and ask for a new link; everything
  else answers `403` with `details.reason: "emailUnverified"`. API keys are
  unaffected. Off by default. (#132)

### Operations

- **Nothing is sent until you configure a relay.** The default
  `MAIL_TRANSPORT=log` writes every message, links included, to the **worker**
  log (reset links used to be in the **API** log). To send, set
  `MAIL_TRANSPORT=smtp` and `MAIL_SMTP_URL` (`smtps://user:pass@host:465` or
  `smtp://…:587`, URL-encoded credentials) and a `MAIL_FROM` on a domain whose
  SPF and DKIM records the provider has given you; without them mail lands in
  spam. `MAIL_TRANSPORT=smtp` with an empty `MAIL_SMTP_URL` refuses to boot.
  Prove the box can reach the relay first:
  `docker compose exec api node dist/scripts/send-test-mail.main.js --to you@example.com`
  (or `make mail-test to=…` locally). The worker also logs the relay check at
  boot.
- New env vars, all defaulted: `MAIL_TRANSPORT` (`log`), `MAIL_SMTP_URL` (empty),
  `MAIL_FROM` (`Knowledge <no-reply@localhost>`), `MAIL_NOTIFICATIONS_ENABLED`
  (`true`), `AUTH_VERIFY_TTL_HOURS` (48), `AUTH_INVITE_TTL_HOURS` (72),
  `AUTH_REQUIRE_VERIFIED_EMAIL` (`false`).
- Migration `20261012120000_mailer` is expand-only and survives a rollback to
  0.15.0. It adds `users.email_verified_at`, `notifications.emailed_at`,
  `notification_preferences.email_directed`, `password_reset_tokens.purpose` and
  the `email_verification_tokens` table, and backfills every existing account as
  verified and every existing notification as already mailed, so nobody is
  locked out or sent old news.
- Local dev: `make infra-up-mailpit` starts a loopback mail catcher (SMTP `:1025`,
  inbox `http://localhost:8025`).
- **Production config now lives in the GitHub `production` environment, and
  the next deploy fails until it is filled.** `deploy.yml` writes
  `~/Homelab/infra/knowledge/.env` from that environment's variables and
  secrets on every deploy (0600, previous copy kept as `.env.bak`). A hand edit
  on the box therefore lasts only until the next release: rotate a secret in
  Settings › Environments, then redeploy. The deploy stops before building if a
  key that `.env.production.example` gives a value to is missing, or a value
  still contains `CHANGE_ME`, a newline or a single quote. **Before tagging,**
  fill the environment once from the box's current file (dry run first, then
  `--apply`):
  `ssh macmini 'cat ~/Homelab/infra/knowledge/.env' | node scripts/env-to-github.mjs .env.production.example -`.
  Names containing `PASSWORD`, `SECRET` or `TOKEN`, names ending `_KEY`, and
  `DATABASE_URL` / `MAIL_SMTP_URL` become secrets; everything else becomes a variable.
  GitHub refuses names starting `GITHUB_`, so store those as `GH_*`
  (`GH_API_URL`, `GH_APP_ID`, …); the script does this for you and the deploy
  renames them back. (#134, #138)
- **New required secret `SEARXNG_SECRET`**, SearXNG's `server.secret_key`. The
  deploy now ships the repo's `searxng/settings.yml` over the hand-managed copy
  on the box, and the secret overrides that file's dev placeholder:
  `openssl rand -hex 32 | gh secret set SEARXNG_SECRET --env production`.
  Rotating it only invalidates SearXNG's own cookies. (#134)

## [0.15.0] — 2026-10-12

### Added

- **Pages have an owner, a review interval and an expiry.** `PATCH
/v1/documents/:id` takes `ownerId` (a workspace member, or `null`) and
  `reviewIntervalDays` (`null` inherits the workspace default, `0` never
  expires); `POST /v1/documents/:id/verify` takes `{ intervalDays }` and the
  stamp now reads `expired` once its interval has passed, with nothing written.
  The owner is told when somebody asks for a check, marks the page outdated or
  hands it to them, under a new `verification` notification category that can
  be muted. First part of the page verification milestone (#66).
- **Ask for a check, or declare a page wrong.** Any member can `POST
/v1/documents/:id/verification-request`; an editor can `POST
/v1/documents/:id/outdated`. Both take a note and show on the page as
  `requested` / `outdated` until a person verifies or clears it (`DELETE
/v1/documents/:id/verify` now clears both the stamp and the flag). Over MCP,
  `knowledge_flag_document` does the same with the same roles; there is
  deliberately no tool that verifies. (#66)
- **Archive a page or a subtree.** `POST /v1/documents/:id/archive` (and
  `/unarchive`) puts a page and, by default, everything under it away: hidden
  from the page list, the tree, search, the assistant and MCP unless
  `includeArchived` is asked for, still readable by id, and refusing writes with
  `409 document_archived`. Archive is a visibility default, not a permission.
  (#66)
- **Search ranks by trust.** Hybrid, semantic and keyword search — and so the
  assistant's `ask` and MCP `knowledge_search` — multiply each hit's score by
  its page's verification state: verified pages rank above unverified ones,
  expired and reported pages below, pages declared outdated last, and pages with
  no activity for `PAGE_INACTIVE_AFTER_DAYS` a little lower still. Every hit
  carries `trust: { status, verifiedAt, expiresAt, ownerId, inactive }`, and
  `filters.verificationStates` / `filters.includeArchived` narrow a search.
  `SEARCH_TRUST_RANKING=false`, or a workspace's `trustRanking` override,
  restores the previous order exactly. (#66)
- **Knowledge-health API.** `GET /v1/knowledge-health` lists a workspace's pages
  with their derived status, filtered by `stale | unowned | empty | expired |
edited | outdated | requested | flagged | inactive | archived`, owner, project
  and title; `/summary` counts each filter live; `POST /bulk` runs verify /
  request / outdated / clear / reassign / archive / unarchive over up to 200
  pages with per-id results, refusing the whole batch when one id belongs to
  another workspace; `GET`/`PATCH /settings` reads and overrides the
  workspace's freshness policy, showing what applies beside what is overridden.
  The dashboard page that uses it ships in a later part of #66. (#66)
- **The owner hears before a verification runs out, and once it has.** A
  sweeper in the API process reminds a page's owner (or its last verifier)
  `VERIFICATION_REMIND_BEFORE_DAYS` before the stamp expires — per workspace,
  `remindBeforeDays` in the knowledge-health settings overrides it, `0` turns
  reminders off — and announces the expiry when it passes, once each per stamp
  even with several API replicas running. The expiry lands in the activity feed
  under a `system` actor; both notifications ride the `verification` category
  and can be muted. The same tick fills `body_chars` for revisions indexed
  before that column existed, so the dashboard's "empty" filter stops reading
  as unknown for old pages. `VERIFICATION_SWEEP_ENABLED=false` turns it off.
  Part of #66. (#66)
- **A drift check now marks the page, not just the pull request.** With a
  connector's drift check on, every page the sentinel finds wrong is flagged
  `requested` for its owner, with the pull request and the finding as the note.
  When that pull request merges — GitHub `closed` with `merged`, GitLab `merge`,
  neither of which starts a check — the pages still `requested` become
  `outdated` and rank last until somebody verifies them. A page verified after
  the check started, cleared by hand, or whose proposed fix already merged is
  left alone, and an owner who can no longer edit cannot declare a page
  outdated. The new connector option **Flag the pages it finds wrong**
  (`driftFlagPages`, on by default, effective only with the check on) turns it
  off. A stale finding in the agent runs panel gains **Mark outdated** beside
  Propose (`POST /v1/ai/agents/runs/:id/findings/:index/mark-outdated`,
  editor), explicit and offered once. (#66)

- **The page shows its verification, its owner and the way to change both.**
  A **Verification** widget heads every page's rail, folding like the widgets
  under it, and reads the derived state — verified,
  expired, edited since, requested, reported, outdated — with who stamped or
  flagged it and when (a drift flag links to its pull request), the owner, and
  the actions the reader's role allows: **Verify** with a review interval
  (workspace default, 30/90/180/365 days, never), **Request verification** for
  any member, **Mark outdated**, **Clear verification** and **Archive** for
  editors. An archived page shows when and by whom with **Unarchive** instead,
  loses its Edit action, and the editor route sends you back to it. The page tree, the
  rail, the page list and the search sheet mark pages whose state asks for a
  look, and the pages index gains a **Show archived** switch. Every action
  reflects live in other tabs. (#66)
- **A knowledge-health dashboard.** `/knowledge-health`, in the rail beside
  merge requests and workflows, lists the workspace's (or the active
  project's) pages most neglected first, with a preset strip — _Needs
  attention_, _Unowned_, _Empty_, _Expired_, _Edited since verified_,
  _Outdated_, _Requested_, _Reported_, _Inactive_, _Archived_ — each carrying
  its live count, and narrowing by title, owner and sort. Editors select rows
  (shift for a range, cmd/ctrl to add one, Escape to clear) and run one action
  over all of them: verify with a review interval, reassign, request a check,
  mark outdated, clear verification, and for admins archive and unarchive;
  each page that refuses says why. A preview sheet shows a page's verification
  widget and body beside the table. The **Settings** tab shows the workspace's
  freshness policy — what is overridden beside what applies and the server
  default — and lets an admin change it. The dashboard follows live events, so
  a page verified elsewhere moves off the strip as you watch. (#66)

### Changed

- **A verified page that has since been edited now reads `edited`, not
  `outdated`.** `outdated` is reserved for a page somebody declared wrong (a
  person, the sentinel, or an agent over MCP), so that ranking and the health
  filters can tell "touched since the check" from "known to be wrong". The
  provenance card, the `verification` field on `GET /v1/documents/:id` and
  `knowledge_search` hits, and the confidence badge all use the new name. (#66)
- The provenance chip under an assistant answer now names every verification
  state; it had shown the raw message key for a page that read `edited`,
  `expired` or `requested`. (#66)
- Verifying, flagging, owning and archiving a page count as curation in the
  activity calendar rather than as writes. (#66)

### Operations

- New env vars, all with defaults, all overridable per workspace through
  `PATCH /v1/knowledge-health/settings`: `VERIFICATION_DEFAULT_REVIEW_DAYS`
  (90), `VERIFICATION_REMIND_BEFORE_DAYS` (7), `PAGE_INACTIVE_AFTER_DAYS`
  (180), `EMPTY_PAGE_MAX_CHARS` (40), `VERIFICATION_SWEEP_ENABLED` (true),
  `SEARCH_TRUST_RANKING` (true). (#66)
- Migration `20261011120000_page_verification` adds nullable or defaulted
  columns to `documents` and `document_revisions` and a `knowledge_health_settings`
  table; the previous image runs against it unchanged, so a code rollback needs
  no database step. It backfills `documents.last_activity_at` from revisions and
  the activity log and `documents.owner_id` from each page's first author where
  that author is still a member; pages whose first author was the dev stub or
  has left stay unowned. `document_revisions.body_chars` is not backfilled
  (content lives in object storage): "empty page" reads as unknown for existing
  revisions until the sweeper of a later #66 part fills it. (#66)
- Production moved off the `knowledge-prod` VPS, which is unreachable, to the
  Mac mini. `deploy.yml` now runs on the `knowledge-macmini` runner (macOS,
  ARM64, Colima) and rolls out `~/Homelab/infra/knowledge`; `.env`,
  `searxng/settings.yml` and `admin-bootstrap.txt` live there, hand-managed as
  before. Nothing on the box listens publicly: a Cloudflare Worker on
  `knowledge.hrustalq.dev` forwards to the Mac mini's Tailscale Funnel, which
  serves caddy on `127.0.0.1:8088` (plain HTTP, no ACME). The VPS's data was
  not recoverable, so production started from an empty database. (#126)

## [0.14.0] — 2026-10-10

### Breaking

- **An API key in `?token=` is refused everywhere.** On `GET /v1/events` and the
  attachment, import-image and avatar redirects, `?token=kn_…` is now a 401.
  Scripts should send the key as `Authorization: Bearer`, or mint a ticket with
  it (`POST /v1/auth/url-ticket`) for the SSE stream. (#102)

### Added

- **Answers cite their sentences.** An assistant reply now ends each factual
  sentence with a marker for the page it rests on, shown as a superscript
  number; hovering it highlights the source chip, clicking it opens the page at
  the cited section. A marker naming a page the assistant was never given is
  removed before the answer is stored. Available on `/assistant`, in the editor
  assistant and on `POST /v1/assistant/ask` (`citations`). First part of the
  answer trust milestone (#67).
- **Every cited page says how trustworthy it is.** Source chips carry a
  provenance card: revision number, author, how long ago the page changed, its
  verification state and how the fact reached the answer (page text, frontmatter,
  an inferred or a curated relation). The same fields, plus a `traceId`, are on
  every `knowledge_search` hit over MCP. (#67)
- **A confidence badge on every answer** — high, medium, low or unsupported —
  derived from what the harness observed (citation coverage, retrieval score,
  stale or unverified pages, failed tool calls, a spent tool budget), with each
  reason spelled out on hover. Never the model's own opinion of itself. Also on
  `POST /v1/assistant/ask` (`confidence`). (#67)
- **Verify a page.** An editor can stamp a page as checked at its current
  revision (`POST /v1/documents/:id/verify`, `DELETE` to remove). The stamp
  reads as outdated the moment a new revision is published, with no write;
  answers that cite the page show the same state. (#67)
- **Rate an answer.** Thumbs up/down under every assistant reply on
  `/assistant` and in the editor assistant, and under one-shot answers in the
  page's Ask AI widget. A thumbs-down asks for a reason (wrong, out of date,
  incomplete, wrong pages cited, no answer, unclear, other) and takes an
  optional comment; pressing the active thumb takes the vote back, and a vote
  survives a reload. Over the API: `PUT`/`DELETE
/v1/assistant/messages/:id/feedback` and `POST /v1/assistant/ask/feedback`,
  open to read-only API keys. Second part of the answer trust milestone (#67).
- **Coverage gaps.** A new built-in `surveyor` agent reads the questions the
  assistant was down-voted on, answered with low confidence or could not
  answer, clusters them by meaning with the workspace's embedding provider, and
  reports each topic asked often enough as a gap: how many times, from where,
  the sample questions, what the workspace already says, and one proposed fix
  — a drafted page, an edit to the page that should hold the answer, or an
  archaeologist run over the connected repository. A new **Coverage** tab on
  the AI settings page shows the latest survey as cards with a one-click
  **Draft page**, **Propose update** or **Run archaeologist**, and **Survey
  now**; the agent can also be scheduled like any other. Fourth part of the
  answer trust milestone (#67).
- **Agents can rate what they read.** A new `knowledge_feedback` MCP tool
  takes a rating, a reason and the `traceId` of the `knowledge_search` it
  answered from, so a re-vote on the same search updates one row. Hidden from
  read-only keys like every other write; the server instructions and the
  generated skill tell an agent when to call it. (#67)
- **Weak answers leave a trace on their own.** An answer the harness scored
  `low` or `none` confidence is recorded as an implicit `low-confidence` /
  `no-answer` signal, so the coverage-gap agent of a later phase has something
  to cluster even when nobody voted. (#67)
- **Report a problem with a page.** A new **Reports** widget in the page rail
  lists open reports and lets a reader file one: what kind of problem, what is
  wrong, the passage disputed and where the right information is. A report is
  checked by the sentinel against the page and, when it holds up, becomes a
  draft merge request for a person to review; an editor who pastes the
  corrected body gets that merge request at once, in their name. A page with
  an open report shows as **Reported** on its Verify button and as `flagged`
  on every answer that cites it; editors resolve or dismiss reports from the
  rail. A second report of the same page and kind folds into the open one.
  Over the API: `POST /v1/knowledge-issues`, `GET /v1/knowledge-issues`,
  `PATCH /v1/knowledge-issues/:id`. Third part of the answer trust milestone
  (#67).
- **A thumbs-down names its pages.** Voting an answer down as _wrong_ or _out
  of date_ offers, ticked by default, to report the pages it cited — one
  report per page, after the vote itself is stored. (#67)
- **Agents can report what they read.** A new `knowledge_report_issue` MCP
  tool takes the page, the kind of problem, what is wrong and the evidence;
  the server instructions and the generated skill tell an agent when to call
  it. A report never edits a page by itself. Hidden from read-only keys like
  every other write. (#67)
- **Page authors hear about reports.** The last author of a reported page gets
  a notification under _Page changes_; the feed records `reported`,
  `proposed`, `resolved` and `dismissed`. (#67)

- **Feedback becomes a test set.** A new **Feedback** tab on the AI settings
  page lists every vote and weak-answer signal — the question, the cited pages,
  the surface, the confidence the answer had — with counts for the last 30
  days, and an **Export dataset** button that downloads the votes as NDJSON
  (`GET /v1/ai/feedback/export`, admin-only, audited). Each line is one
  labelled retrieval case: an up-vote names the pages that answered, a
  "wrong" or "irrelevant sources" down-vote names the pages that did not, and
  a report that ended in a merged fix names the page that answers now.
  `make backtest ARGS="--export-feedback --workspace <id> --out fb.ndjson"`
  writes the same file from the database, and `make backtest ARGS="--feedback
fb.ndjson"` replays it through search and prints recall@1, recall@k, MRR
  and how often a rejected page still ranks, split by surface and by reason.
  Last part of the answer trust milestone (#67).

### Security

- **Single-use tickets replace credentials in the event-stream URL.**
  `POST /v1/auth/url-ticket` trades a header credential for a `kt_` ticket that
  works once and expires in `AUTH_URL_TICKET_TTL_SEC` (60 s). The web app opens
  `GET /v1/events` with one, so the session token no longer appears in any
  access log for the stream. (#102, phase 2)

### Operations

- Migration `20261010120000_answer_provenance` adds `citations` and
  `confidence` to `assistant_messages` and `verified_at` / `verified_by` /
  `verified_revision_id` to `documents`. Expand-only, nullable or defaulted, no
  backfill: the previous release's image runs against it, so a code rollback
  needs no database step.
- New env var `ANSWER_STALE_SOURCE_DAYS` (default `180`): a cited page whose
  head changed longer ago than this counts as stale evidence in the confidence
  score. Lowers the badge; hides nothing.
- New optional env var `AUTH_URL_TICKET_TTL_SEC` (default 60, 5–3600). Tickets
  live in the existing Redis. (#102)
- New env `ANSWER_FEEDBACK_ENABLED` (default `true`). `false` refuses the vote
  routes and `knowledge_feedback` and records no implicit signals — for an
  operator who does not want question text stored in PostgreSQL. Migration
  `20261010135843_answer_feedback` creates the `answer_feedback` table only
  (expand-only; the previous image runs against it). Votes store the question
  as typed, the first 1 000 characters of the answer and the cited page ids;
  retention is phase 3 of #67. (#67)
- Migration `20261010142919_knowledge_issues` creates the `knowledge_issues`
  table only (expand-only; the previous image runs against it, so a code
  rollback needs no database step). New env vars, all with defaults:
  `KNOWLEDGE_ISSUE_DAILY_LIMIT` (`50` reports per principal, per API key when
  one is used, per 24 h — past it a report is a 429 naming the limit),
  `KNOWLEDGE_ISSUE_MAX_PENDING_CHECKS` (`10` sentinel report checks waiting per
  workspace — past it a report stays open for a person instead of queueing a
  model run), `ANSWER_FEEDBACK_RETENTION_DAYS` (`180`: feedback rows and
  closed reports older than this are purged, in batches, by the report
  sweeper once an hour; open reports are never purged). A report check runs
  the `sentinel` agent and spends the reporter's AI budget; with the sentinel
  disabled every report stays open. (#67)
- New env vars for the `surveyor` agent, all with defaults and no migration:
  `COVERAGE_WINDOW_DAYS` (`30`: how many days of answer feedback a run reads),
  `COVERAGE_MIN_CLUSTER_SIZE` (`3`: the smallest topic reported),
  `COVERAGE_SIMILARITY` (`0.82`: the cosine a question must reach to join a
  topic), `COVERAGE_MAX_QUESTIONS` (`2000`: the most feedback rows read per
  run). A survey embeds every distinct question through the configured
  embedding provider and makes at most twelve model calls, as the run's owner.
  On `EMBEDDINGS_PROVIDER=stub` the surveyor refuses rather than cluster on
  hashed words, so it is not usable in a stub-embedding deployment. Off unless
  someone presses Survey now or schedules the agent. (#67)
- The feedback export (`GET /v1/ai/feedback/export`, `make backtest
--export-feedback`) carries question text and user ids: it is admin-only,
  every call writes an `audit_logs` row (`feedback.export`, with the line
  count), and one export reads at most 50 000 votes. No new env var and no
  migration; retention (`ANSWER_FEEDBACK_RETENTION_DAYS`) bounds the dataset
  as it bounds the table. (#67)

## [0.13.0] — 2026-09-27

### Added

- **A page as plain markdown for agents.** `GET /v1/documents/:id/markdown`
  returns the page as `text/markdown` (`# title` + body; `?frontmatter=1` adds
  the page's YAML with provenance under `knowledge:`), and
  `GET /v1/documents/:id/content` answers the same when the request prefers
  `Accept: text/markdown`. Same access as reading the page, read-only API keys
  included; `ETag` / `If-None-Match` answers `304` without re-reading storage.
  First part of AI-readable output (#68).
- **`llms.txt` for your knowledge base.** `GET /v1/llms.txt` lists the
  workspaces your key can read; `/v1/workspaces/:id/llms.txt` and
  `/v1/projects/:id/llms.txt` index their pages (tree order, links to each
  page's markdown); the matching `llms-full.txt` streams every page's text in
  one response, capped and recorded in the audit log. Drafts and unmerged
  branches never appear. (#68)
- **Page and llms.txt URLs on the web origin.** `/documents/<id>.md` returns a
  page as plain markdown, and `/documents/<id>` does too when the request sends
  `Accept: text/markdown` (a browser still gets the app). `/llms.txt`,
  `/workspaces/<id>/llms(-full).txt` and `/projects/<id>/llms(-full).txt` work
  on the same host. A logged-in tab is authenticated by its session; an agent
  sends its API key as a bearer token, and without one gets a plain-text 401
  that says where to create a key. (#68)
- **Admins decide whether pages may be opened in ChatGPT, Claude or Cursor.** A
  new switch under AI settings controls whether a page's upcoming AI actions
  menu offers "Open in ChatGPT / Claude / Cursor", which put the page's text
  into a link to that vendor. Copying a page as Markdown is never affected.
  Members can read what the menu may offer from `GET /v1/ai/page-actions`. (#68)
- **Hand a page to an AI tool from its header.** Every page now has a
  **Copy page** button that copies it as Markdown, with a menu beside it:
  view the raw Markdown, open the page in ChatGPT, Claude or Cursor (when the
  workspace allows it), copy the MCP install config for your AI client, or
  copy an agent link. No link or snippet ever contains an API key. (#68)
- **Pages and llms.txt over MCP, and llms.txt links on Connect AI.** MCP
  clients can read a page as markdown (`knowledge://documents/<id>.md`) and a
  workspace's or project's `llms.txt` as resources, with the same access checks
  as the app. Settings → Connect AI gains an "llms.txt and markdown" card with
  copyable links for your workspace and current project plus a curl example,
  and the generated skill lists each workspace's `llms.txt`. (#68)

### Operations

- **MinIO now comes from `pgsty/minio` and `pgsty/mc`, pinned by tag and
  digest.** Upstream stopped publishing pullable images:
  `docker.io/minio/minio` is gone, and `quay.io/minio/*` answers `401` to
  anonymous pulls. Until now a fresh machine or a prod deploy that pulls
  could not start `minio` / `minio-init`.
  - Both images are Pigsty's community rebuild of the same MinIO server and
    `mc` client.
  - Existing data volumes are read as-is: versioned buckets and version ids
    are kept. No migration and no env change.
  - `docker compose pull` on a deploy is enough.
  - If you pinned `quay.io/minio/*` in an override file, drop it. (#104)
- `AI_READABLE_ENABLED` (default `true`) — kill switch for the markdown and
  `llms.txt` routes and the matching MCP resources.
- `LLMS_FULL_MAX_DOCS` (2000), `LLMS_FULL_MAX_BYTES` (20 MB) and
  `AI_READABLE_FETCH_CONCURRENCY` (8) bound one `llms-full.txt` response.
- `AI_EXTERNAL_ACTIONS_ENABLED` (default `true`) is a ceiling for that switch:
  `false` turns the external actions off in every workspace, and the settings
  page says the deployment turned them off. `AI_ACTION_INLINE_MAX_CHARS`
  (default `6000`) is the longest page put inline into such a link; a longer
  page is copied to the clipboard instead. Migration
  `ai_settings_external_ai_actions` adds one nullable column. (#68)
- **Run `make graph-live-backfill` once after deploying.** New indexing stamps
  which revision is live, but data indexed before this release carries no flag
  and is still served as before — stale revisions included — until the
  backfill stamps it. It is idempotent, safe while the worker runs, takes
  `ARGS="--workspace <id>"` and `ARGS="--dry-run"`, and touches ArcadeDB and
  (with `FULLTEXT_PROVIDER=opensearch`) the OpenSearch index. No PostgreSQL
  migration.
- **Re-run `make backtest ARGS="--generate"` for a new baseline.** Recall and
  MRR measured before this release counted stale revisions as matches, so the
  numbers will move and are not comparable with earlier runs.
- **Query tokens are masked in logs.** The API's request log and error log
  write `token=[REDACTED]`, and the bundled `Caddyfile` filters the access log
  to `token=REDACTED`. Pull the new `Caddyfile` when you deploy; a proxy of
  your own in front of the API needs the same filter. (#102)

### Fixed

- **Search, the graph and agents only see what a page says now.** Text removed
  from a page, tags and relations dropped from its frontmatter, and drafts on a
  branch that was never merged used to keep turning up — in search results and
  snippets, the tag filter, graph view, entity pages, impact analysis, the
  relations panel and the context handed to agents and MCP clients. Every
  revision is still kept for the revision diff and the facts history; only the
  current published revision of each page is served. The same page also no
  longer comes back once per old revision. (#83)
- **The Russian interface is fully Russian.** Template copy, button labels,
  tooltips, placeholders, import verdicts and errors raised by background jobs
  used to show in English whatever the UI language was; they are translated
  now, and a failed run reports in the language it was started in. Dates,
  numbers and sizes follow the UI language instead of the server's, and CI
  rejects new untranslated text or unused message keys. (#85)
- **Fresh installs can pull MinIO again** — see Operations. (#104)

### Breaking

- **`?token=` authenticates only the routes that cannot send a header.** An API
  key or session token in the query string used to work on every route, so a
  key pasted into a URL (a `.md` link, `llms-full.txt`, even a write) was a
  live credential in access logs, browser history and `Referer` headers. It is
  now accepted only on the SSE stream (`GET /v1/events`) and the `<img>`
  redirects (attachment content, import images, user and project avatars);
  anywhere else it is ignored and the request is a `401`. The live WebSocket
  (`/v1/events/ws`) is unchanged.
  **Migration:** send `Authorization: Bearer <key>` instead. (#102)
- **A connector's links, runs and work items come back a page at a time.**
  `GET /v1/connectors/:id/links`, `/runs` and `/work-items` now return one page
  (50 links, 30 runs, 50 work items by default) and a `nextCursor`; links used to
  return up to 500 rows in one response, work items up to 200. Work items also
  carry `total`, the count across every page.
  **Migration:** a caller that needs everything keeps requesting with
  `cursor=<nextCursor>` until it is `null`; `limit` takes 1–100. (#88)

### Changed

- **Long connector lists scroll inside the page.** On a connector's page the Work
  items, Links and Runs tabs now end at the bottom of the window and scroll on
  their own, loading more as you reach the end, so a connector with hundreds of
  linked pages no longer makes the whole page one very long scroll. The same
  applies to the Runs and Links tabs under **Settings → Connectors**, which also
  used to stop silently at the first 20 runs or 500 links. (#88)
- **The GitHub access card folds.** It starts folded when nothing is wrong,
  showing whose installation it is, and open when a permission is missing or
  pending, showing how many. Your choice is remembered while you move between
  connectors. (#88)

## [0.12.0] — 2026-09-27

### Added

- **See what GitHub has granted a connector, and fix it from there.** A connector
  on a github.com repository now has a **GitHub access** card (admins only)
  listing every permission and webhook event its App installation has, next to
  what each feature needs — sync, publishing, work items, the drift check. A gap
  says whose job it is: _pending_ permissions are accepted by the installation's
  owner (**Review on GitHub**), _missing_ ones must first be added to the App
  registration (**Edit the App**). Gaps in features the connector does not use
  are shown but not flagged. (#64)
- **Reconnect or disconnect your GitHub account.** The same card shows which
  GitHub account you are linked as and whether its authorisation has lapsed.
  **Reconnect** runs GitHub's authorisation again with the account picker, so
  you can switch accounts; **Disconnect** forgets your link without touching the
  workspace's installations or any sync. (#64)

### Changed

- **The editor's assistant opens on the right.** It used to take the navigation
  rail's place on the left; it now docks beside the page on the right, and the
  rail stays as you left it. (#84)
- **The editor uses the width of the window.** The title and text used to sit in
  a narrow centred column with wide empty margins; they now fill the editor,
  with a margin that grows with the window. Reading a page is unchanged. (#84)
- **Leaving the editor with unpublished changes asks first.** Changes are still
  kept in the browser and restored when you come back, but following a link away
  now asks whether to keep or discard them. Tick **Don't ask again** to go back
  to leaving without the question; a browser that refuses to keep the changes
  always asks. (#84)
- **Settings → AI and Settings → Connectors fill the page** instead of stopping at
  a fixed width, and the AI form's fields sit side by side on wide screens. (#84)

### Fixed

- **The description on a merge request's overview no longer sits in an
  oversized box.** Its padding now matches the merge panel above it. (#84)
- **The leave dialog's buttons no longer overflow the dialog** in Russian. (#84)

## [0.11.0] — 2026-09-26

### Added

- **Pull and merge requests are checked for documentation drift.** Turn on
  **Drift check** on a GitHub or GitLab repository connector (Codebase or
  Markdown / Git), and every pull or merge request that opens, leaves draft or
  gets new commits is read by a new background agent, the **Sentinel**. It finds
  the pages about the code the change touches — pages the connector derived,
  pages that name a changed file, and a few search hits — decides page by page
  whether the change makes something on it untrue, and drafts the corrected
  page. In _Report_ mode it leaves one comment on the pull request listing the
  pages that drifted, updated on every push; in _Propose_ mode it also opens a
  merge request here for each drafted correction. Forks and drafts are never
  checked, and nothing changes a page until a person merges. (#61)

### Fixed

- **Proposing a fix from an agent finding no longer strips the page's tags and
  relations.** The proposed revision was written without the page's frontmatter,
  so merging it deleted `tags:`, `relations:` and `source:` along with their graph
  edges. The frontmatter is now kept. (#61)

### Operations

- Off by default; nothing changes for existing connectors. The GitHub App needs
  no new permission or event — it already receives _Pull request_ events and has
  _Pull requests_ / _Issues: Read and write_ since 0.9.0. A connector using a
  token, and every GitLab connector, needs a **Webhook secret** set on the
  connector and a repository webhook pointed at
  `$API_PUBLIC_URL/v1/connectors/<id>/webhook` with _Pull requests_ (GitHub) or
  _Merge request events_ (GitLab) selected. See
  [docs/features/35](docs/features/35-pr-drift-check.md#setup).

## [0.10.1] — 2026-09-26

### Fixed

- **Agent edits no longer strip a page's tags and relations.** An agent that read
  a page and posted it back through `knowledge_create_revision` or the assistant's
  `propose_update` got the body without its frontmatter, so the merge request
  quietly deleted the page's `tags:` and `relations:` and, once merged, its graph
  edges. A body sent without a frontmatter block now keeps the current one; send a
  block to change it. (#58)
- **Relations written as `targetKey:` reach the graph.** Frontmatter relations
  spelled `{type, targetKey, name}` — the shape every tool schema uses, and so the
  one agents write — were dropped at indexing without an error. They are now read
  like `target:`. (#58)

### Operations

- Pages already written with `targetKey:` need a reindex to gain their edges
  (`knowledge_ingest` on the workspace). Pages an agent already stripped are not
  repaired automatically — their frontmatter is still in the revision history.

## [0.10.0] — 2026-09-26

### Added

- **The editor's assistant is a sidebar that writes into the page.** Press the
  Assistant button or `⌘J` / `Ctrl+J`: the chat opens on the left in place of
  the navigation rail, with everything the assistant page has. It reads your
  draft as it is on screen, unsaved edits included, and when you ask for a change
  the text streams straight into the page as a suggestion you keep or discard
  (`⌘↵` keeps them all). Nothing is saved until you keep it and publish; publish
  asks you to decide on pending suggestions first. Chat replies now fade in word
  by word too.

- **Unpublished edits survive a reload, a crash or a closed tab.** The page
  editor keeps its working copy in the browser as you write and restores it when
  the page is reopened; if the page was published in the meantime it asks before
  restoring rather than quietly publishing over the newer revision. A header chip
  shows that there are unstaged changes and opens a diff of what publishing would
  write, with a way to discard them. The document page marks its Edit button when
  edits are waiting. Copies stay in the browser they were made in.
- **Connect Claude, Codex, Gemini CLI, Cursor or any MCP client to the knowledge
  base.** The `knowledge_*` tools are now served over Streamable HTTP at
  `POST /v1/mcp`, authenticated with an API key and acting as the key's owner:
  each tool enforces the same workspace role as the REST route it mirrors, and
  every page, revision, merge request and comment it writes is attributed to
  that person. Previously the tools ran only as a local stdio process with full,
  anonymous access. `knowledge_whoami`, `knowledge_list_documents`,
  `knowledge_get_document_content` and `knowledge_create_document` are new, so an
  agent can find its workspaces, browse, read a page in full and add one.
- **Settings → Connect AI** (`/settings/connect`) gives the exact command and
  config file for Claude Code, Codex, Gemini CLI, Cursor, VS Code, Claude
  Desktop, Windsurf, opencode and Zed — each in that client's own syntax, with a
  newly created key already filled in.
- **API keys can be named, narrowed and revoked one at a time.** Create as many as
  you need — one per client and machine — each optionally read-only, pinned to one
  workspace, or expiring, and see when each was last used. A read-only key cannot
  write anywhere, even when its owner is a platform admin, and a connected client is
  not offered the write tools at all. `GET|POST /v1/me/api-keys`,
  `DELETE /v1/me/api-keys/:keyId`
- **An agent skill generated for you.** `GET /v1/mcp/skill` returns a `SKILL.md`
  listing your workspaces and project ids, the tools your key is offered, and how
  to use them — answer with citations, change pages only through merge requests,
  trace impact. Install it with one command from the Connect AI page; the MCP
  server also serves it as the resource `knowledge://skill` and the prompt `guide`.

### Changed

- **The editor's toolbar and header no longer overflow on narrow screens.** The
  toolbar folds its less-used controls into a "More" menu as it narrows —
  including when the assistant panel is open — and on a phone the header keeps
  the assistant, a menu for Settings and Cancel, and Publish.

- **Leaving the editor no longer asks, once your edits are stored.** They are
  restored when you come back. Cancel still asks — keep and leave, or discard —
  and the old discard warning remains for a browser that refuses to store them.
- **Typing in long pages is lighter.** The formatting toolbar no longer
  re-renders on every keystroke, the selection bubble and table bar measure the
  page once per frame instead of once per edit, and saving the page to markdown
  skips a full HTML round trip.

### Deprecated

- `POST /v1/me/api-key` (single-key rotation) still works but now revokes **every**
  key you hold before minting one. Use `POST /v1/me/api-keys` instead; it will be
  removed in a later release.

### Fixed

- **The SearXNG instance answered every search with nothing.** Its config
  narrowed the engine roster with `keep_only`, which preserves each engine's
  _default_ state — and upstream ships google as `disabled: true`. Kept but
  disabled, google never fired on a real query, only on an explicit
  `?engines=google`, so the instance returned `200 application/json` with an
  empty `results` array and looked like a working backend that had nothing to
  say. A top-level `engines:` block now enables it; that form _modifies_ the
  engines it names rather than re-widening the roster `keep_only` narrowed. (#52)
- **One of the four configured engines was never loaded.** `keep_only` matches
  engine names, not module names, and a name matching nothing is dropped in
  silence — no warning, absent from `/config`. `stackexchange` is the module;
  the engine built from it is `stackoverflow`. (#52)

### Operations

- **Web research is on in production**, which is a change of posture, not just
  of configuration: `WEB_ACCESS_MODE=open` lets the assistant fetch any domain
  a `source_policies` row does not deny. It was `off`, and both workspaces had
  been asking for `open` and being clamped — which is what the "installation
  allows off" banner in AI settings was reporting. Narrow it per workspace in
  AI settings, or lower the ceiling back to `off` to withdraw it entirely.
- **Two new production environment variables**, both in
  `.env.production.example`: `WEB_ACCESS_MODE` (already present, now `open`)
  and `WEB_SEARCH_URL=http://searxng:8080`. Without the latter, fetching a
  named URL still works and searching does not. Both are read at container
  creation through `env_file`, so they need `up -d --force-recreate api worker`
  — a plain `restart` does not pick them up.
- **A `searxng` service joins the production stack**, ~90 MB against the box's
  3.8 GB. It publishes no host port: its `limiter` is off because the caller is
  this platform rather than a browser, and a published port would put an
  unthrottled open metasearch proxy on the network. The previous note that
  SearXNG "does not fit beside a build" applied to OpenSearch's JVM and has
  been corrected.
- **`/srv/knowledge/searxng/settings.yml` is hand-managed beside `.env`** and is
  deliberately _not_ synced by `deploy.yml`, because it carries a generated
  `secret_key` that must not be the dev placeholder this repo ships. The service
  definition, however, must live in `docker-compose.prod.yml`: deploy installs
  that file over the box's copy and then runs `up -d --remove-orphans`, so a
  service existing only on the box is deleted by the next release.
- **DuckDuckGo serves a CAPTCHA to datacentre IPs** and answers nothing from the
  VPS. It is kept in the roster for the day that changes; until then every
  response carries `unresponsive_engines: [[duckduckgo, CAPTCHA]]`, which is
  noise in the payload, not a failure.
- Migration `20260925120000_api_keys` creates `api_keys` and copies every existing
  `users.api_key_hash` into it, so current keys — including a bootstrapped admin
  key — keep working unchanged. It is expand-only: `users.api_key_hash` is kept
  and no longer read, so rolling back to 0.9.0 still authenticates keys that
  existed before the upgrade. Keys created after the upgrade do not work on 0.9.0.
- `API_PUBLIC_URL` must be the API's public address as clients reach it
  (`https://<host>/api` behind the bundled Caddyfile): it is now the base of the
  MCP URL the Connect AI page hands out, not only of the GitHub OAuth callback.
- `make auth-bootstrap` now **adds** a key instead of replacing the user's
  previous one. Revoke old keys from Settings → Connect AI.

## [0.9.0] — 2026-09-18

### Added

- **Pages can be dragged into place.** The page tree — in the rail and on the
  pages index — now reorganises by dragging: drop onto a page to file something
  under it, drop between two to set the order. Branches open as you hover over
  them, the list scrolls when you reach its edge, and a page dropped onto its own
  descendant is refused rather than detached from the tree. The page moves the
  moment you let go and only its own subtree waits on the server, so a slow
  answer never blocks the rest of the tree; if the move fails it returns to
  exactly where it was and says why.
- **A page can be moved without a mouse.** Space on a page title picks it up,
  the arrow keys walk it through the tree — up and down to choose a neighbour,
  left and right to change how deep it nests — Enter commits and Escape puts it
  back, with each candidate position announced. Every row also carries a `⋯` menu
  with **Move to…**, which is the same move as a destination picker for anyone
  who would rather not drag. `POST /v1/documents/:id/move`
- **A workspace can declare that two entity keys mean the same thing.**
  `POST /v1/entities/aliases` maps one key onto another — `сервис:биллинг` onto
  `service:billing` — and folds the relation edges that already point at the old
  spelling, so a Russian page and an English page about the same service finally
  share one node in the graph. `GET` lists them; `DELETE` retires one.
- **Relations can be declared in Russian.** `связи:` and `теги:` are read as
  frontmatter keys, and relation types accept their Russian spellings
  (`зависит_от`, `описывает`, `реализует`, `связано_с`, `принадлежит`,
  `заменяет`, `противоречит`) alongside the English ones.
- **The assistant can see where pages live.** The page it is looking at now names
  the section it sits in, so "what is this page filed under" costs no lookup. A
  new `list_document_tree` tool browses the rest of the tree, and `read_document`
  and `search_knowledge` results carry a breadcrumb. Pages the assistant creates are placed under the section
  they belong to instead of at the top level, and two pages sharing a title are
  no longer indistinguishable to it.
- **Markdown/git and codebase connectors import with their structure.** A `docs/`
  folder or an Obsidian vault mirrors its folders instead of arriving as one flat
  list of siblings, when the connector has **Preserve hierarchy** switched on. A
  folder becomes a page only if it holds a `README.md`, `index.md` or
  `<folder>.md`; one that does not is transparent, and its pages hang from the
  nearest folder that does.
- **Connectors have a page of their own, and a GitHub connector shows the work on
  the far side.** `/settings/connectors/:id` carries the connection's status,
  the pages it has claimed and its sync history without picking it out of a
  dropdown first — and, for a repository connector, a **Work items** tab listing
  issues and pull requests. You can open an issue from here and attach it to a
  page. (#58)
- **What happens on a connected repository is now something workflows can react
  to.** With the GitHub App's webhook switched on, issues, pull requests, pushes
  and releases arrive as `repo.*` events. A work item attached to a page carries
  that page with it, which is what lets a workflow trigger fire on, say, an
  issue being closed against the page it is about. An unattached issue triggers
  nothing. (#58)
- **Workflows can be started by what happens on a connected repository.** The
  trigger picker offers the `repo.*` events under their own heading, beside the
  page and revision events it already had. Unlike a page event, a repo event may
  fire the same workflow for the same page more than once — an issue that opens,
  closes and reopens is three pieces of news — bounded by a cooldown rather than
  by the "only ever once" rule that page events keep. (#58)
- **The assistant can see and hand off work.** Four tools — `task_list`,
  `task_read`, `task_create`, `task_comment` — offered whenever the workspace
  has a repository connector with issues. Reading is available in both modes;
  opening an issue and commenting on one are Agent-mode-only and need `editor`,
  because unlike a page they cannot be withdrawn once they land. Over MCP,
  `knowledge_list_work_items` reads, and nothing writes. (#58)
- **A workflow can report back to the issue it was about.** A new `task.update`
  step posts its message as a comment on every open issue attached to the run's
  page. It acts only on already-attached items, so a workflow cannot be used to
  comment on an arbitrary repository. (#58)

- **Access is one page again, and it says what a role means.** `/settings/users`
  folded into `/settings/access` as three tabs: **Members** (the roster as it
  was), **Roles**, and **Accounts** — the last only for a platform admin, so a
  workspace admin no longer has a settings row beside theirs that only ever
  403'd. The Roles tab is new: what viewer, editor and admin each grant,
  transcribed from the API's own `@Access` decorators rather than from what the
  names suggest, plus who holds each one and a multi-select to move people
  between them. It says out loud the two things the names get wrong — an editor
  can merge, and a viewer can comment and spend the workspace's AI budget — and
  keeps trusted operator separate, because it is a flag over admin rather than a
  fourth role. `/settings/users` and `/admin/users` redirect.
- **The followed-subjects list names what it follows.** `GET
/v1/notifications/subscriptions` now returns each subject's title and pages by
  cursor (`limit` / `cursor` / `nextCursor`, the shape `/v1/activity` uses).
  A subject that has since been deleted still reports `null`, and the settings
  page shows its id — the honest thing for something that is gone.

### Fixed

- **The settings navigation stays put again when the page scrolls.** The sub-rail
  — settings sections, the project roster, the docs index, the saved
  merge-request filters — was declared sticky but sat inside a container with
  hidden overflow, which silently made that container the thing it stuck to
  rather than the page. (#58)

- **A page moved to a new parent no longer lands in an arbitrary slot.** It kept
  the position it held under its old parent, which collided with whichever
  sibling already held that slot and left the order to be settled by title.
  Moving a page now renumbers both the run it joins and the run it left, so a
  tree that had accumulated collisions repairs itself as its pages are moved.
- **The published API description had drifted.** `openapi.json` and the generated
  web client were regenerated; they were missing the entity-alias routes.
- **Relations declared in frontmatter stopped silently disappearing.** Four
  spellings of the same thing were being treated as four different things, and
  none of them reported a problem — the graph simply came out sparse:
  - a key written `Сервис:Биллинг`, `service: Billing` or `service:billing`
    produced a separate node for each spelling, including invisible Unicode
    differences between a composed and decomposed Cyrillic `й`;
  - a relation type written `depends_on` rather than `DEPENDS_ON` was discarded
    without a trace, even though the same spelling was accepted when a model
    produced it;
  - a page using the Russian `связи:` key produced no relations at all;
  - re-posting a relation through `POST /v1/documents/:id/relations` could leave
    a duplicate edge behind.
- **Tag filters are no longer case-sensitive.** Filtering on `Безопасность`
  returned nothing when pages were tagged `безопасность`, and the empty result
  read as "no such pages" rather than as a spelling mismatch. Search and the
  document list both fold the tag now.
- **Moving a page no longer leaves its children behind on failure.** Re-parenting
  updated the page and its subtree in two separate statements outside a
  transaction, so a failure between them left children in a project their parent
  had already left.

- **A re-index no longer redraws the whole page tree.** A dependent re-index
  emits one event per page it touched, and each one ran a full refresh of the
  list, the tree and the graph — replacing every tree node, which emptied every
  open branch, which each open row then noticed and re-fetched. A burst is now
  collapsed into one refresh, the fetched level is folded onto the nodes already
  held so only rows whose facts changed redraw, and open branches refresh in
  parallel without spinning their chevrons at somebody who pressed nothing.
- **A document page stops rebuilding its editor on every event.** The detail
  poll replaced its response object every two seconds whether or not anything
  had changed, re-rendering the title, both badges and all eight rail previews;
  and any revision event re-fetched the content, tearing down and rebuilding the
  editor — losing the selection, the scroll position and every comment
  decoration. Content is re-read only when the head revision actually changes,
  which is the only thing that can change what the page says.
- **The page rail is reachable when it is taller than the screen.** It was
  sticky but unbounded, so opening three widgets on a long page put everything
  past the fold below the bottom edge with no way to scroll to it. It is now
  bounded to the viewport and scrolls itself, on the document and project pages
  alike.
- **The activity widget keeps its own scroll.** In the document rail its
  scrollport was taller than the card holding it, so the rail scrolled the card
  while the card scrolled the feed — two scrollbars for one list, with the
  paging sentinel on whichever one you were not using.
- **The followed-subjects list is bounded.** Watching is cumulative and nothing
  prunes it, so the card grew to whatever length somebody's watch list happened
  to be and pushed the preference switches above it out of reach. It is now a
  fixed scrollport, virtualized, that pages in as you approach the end.
- **`/settings/ai` fills its column.** It capped at 64rem to stop the right-hand
  edge moving between a form-shaped tab and a table-shaped one, which forced the
  eight-column call log into a horizontal scroller and left the section visibly
  narrower than Profile or Notifications in the same shell. The measure moved
  onto the one panel that is a form.

### Changed

- Pages within a level are ordered by an explicit position, seeded from the
  current alphabetical order — so nothing moves on screen, but ordering is no
  longer permanently tied to the title.
- Building a page's ancestors, its descendants, and the cycle check that guards a
  move are now single indexed queries rather than walks. A deep tree stops
  costing one query per level.

### Operations

- **Two migrations, both additive and both safe to roll back.**
  `20260918083751_entity_aliases` adds a table.
  `20260918084445_documents_materialized_path` adds `path`, `depth` and
  `position` to `documents` and backfills them from the existing `parent_id`
  tree; it is written for the no-FK case, so pages whose parent has been deleted
  are re-rooted rather than skipped.
- `20260918090000_documents_path_rollback_safe` exists specifically so the
  **previous release's image can still write to this schema**, per the
  expand/contract rule. Without it a rollback to v0.8.0 would have failed every
  page creation on a not-null violation. Pages created while rolled back carry a
  `/pending/` placeholder path; they behave as top-level pages and are inert in
  subtree queries. After rolling forward again, repair them with the recursive
  CTE from `20260918084445_documents_materialized_path`, or by touching each
  page's parent. To find them:
  `SELECT id, title FROM documents WHERE path = '/pending/';`
- **No re-indexing or re-embedding is required.** `EMBED_RECIPE` is unchanged.
  Entity keys written before this release converge on their canonical spelling
  as pages are next indexed; to converge a whole workspace at once, run
  `POST /v1/ingestion/reindex`. Declaring an alias folds existing edges
  immediately and does not wait for a reindex.
- **One new environment variable, `GITHUB_APP_WEBHOOK_SECRET`, and it is
  optional.** Empty is the off switch, matching `GITHUB_APP_ID`: with no secret
  the new `POST /v1/connectors/github/webhook` endpoint refuses every delivery
  rather than trusting an unsigned one, and everything else — connectors on a
  personal access token, connectors on an App installation, the existing
  per-connector webhook — is unchanged.
- **Turning the feature on means changing the GitHub App registration**, not
  just the environment. On `https://github.com/settings/apps/<your-app>`: set
  Repository permissions → Issues and Pull requests to **Read and write**,
  Organization permissions → Projects to **Read and write**, switch the Webhook
  to **Active** with URL `$API_PUBLIC_URL/v1/connectors/github/webhook` and the
  secret above, and subscribe to Issues, Issue comment, Pull request, Pull
  request review, Push, Release and Project v2 item. An installed App picks up
  new permissions only once an org owner approves them. See
  [docs/features/32](docs/features/32-connector-work-items.md).
- **A second optional environment variable,
  `WORKFLOW_REPO_RETRIGGER_COOLDOWN_MINUTES`** (default 60). It bounds how often
  one workflow can be re-triggered for one page by repository events. Page
  events are unaffected and keep their absolute "only ever once" guard, so no
  existing workflow changes behaviour.
- **One migration, additive and reversible.**
  `20260918122949_connector_work_items` adds a table and nothing else, so the
  previous release's image runs against this schema unchanged and a rollback
  drops no data anything else reads.

- Ships a migration that replaces `notification_subscriptions`'
  `(workspace_id, user_id)` index with `(workspace_id, user_id, created_at)`, so
  the newly paged list's keyset scan stays index-only. Index only — no data
  moves, and the previous release runs against it unchanged, so it is safe under
  a rollback by retag.

## [0.8.0] — 2026-09-17

### Added

- **The assistant can read a connected repository.** Four tools — `code_tree`,
  `code_search`, `code_outline`, `code_read` — are offered in chat and to the
  `researcher` and `author` agents whenever the workspace has an enabled
  codebase or markdown/git connector. Answers cite files by path and line, and
  the sources rail links to the file on its host. Repository contents are
  wrapped as untrusted data, like web pages. (docs/features/31)
- **The archaeologist reverse-documents a repository.** A new background agent,
  scoped to one codebase or markdown/git connector: it reads what the
  repository's documents and the workspace's pages already declare, ranks the
  source files by how much they decide, reads the ones nothing mentions, and
  proposes a complete page per finding, citing the lines it rests on. **Create
  page** in the Runs tab publishes a draft under the connector's destination;
  a second run treats that page as declared. (docs/features/31)

### Fixed

- **Two concurrent parses no longer share a grammar.** The tree-sitter parser
  set its language in one async step and parsed in another; a second caller
  could switch the language in between. Harmless while only the sequential sync
  pipeline parsed; not harmless once the API does.
- **The repository picker no longer blames the query for an empty roster.** A
  loader that legitimately returned nothing fell through to "no match for X",
  so an installation with zero granted repositories read as a failed search —
  in hardcoded English. Autocomplete now holds queries shorter than its minimum
  and says how many characters it wants; the picker names the zero-grant case
  and links to where it is fixed. (#36)

### Operations

- New env vars, both with defaults: `CODE_SNAPSHOT_TTL_MS` (600000) and
  `CODE_SNAPSHOT_MAX_BYTES` (268435456) bound how long a downloaded repository
  is held in memory for the code tools and how much a process may hold.

## [0.7.1] — 2026-09-17

### Fixed

- **Switching GitHub account in the repository picker reloads the list.** The
  search control refetches only when its query changes, and the account was read
  through a closure it could not see change — so picking a different account
  left the previous one's repositories on screen. With the list scoped to one
  account and no refresh on switching, searching for a repository held by the
  other account looked like search being broken. The picker now also says which
  account it is searching. (#33)

## [0.7.0] — 2026-09-17

### Added

- **A GitHub repository picker for the codebase and Markdown/Git connectors.**
  Instead of pasting a repository URL, a branch and a personal access token, a
  workspace installs a GitHub App once and then picks: an account and
  organisation switcher, a searchable repository list, and a branch dropdown
  that opens on the repository's real default branch. Browsing authenticates as
  the person, so the switcher shows only the organisations they can reach;
  syncing authenticates as the installation, so a scheduled sync survives their
  authorisation expiring. Repositories reached this way store no credential at
  all — the token is minted per run and expires within the hour. (#29)

### Fixed

- **A repository that cannot be downloaded now says which of the three reasons
  it was.** GitHub answers 404 for "no such repository", "you cannot see this
  repository" and "no such branch" alike, and the failure was reported as the
  bare status. It now names the credential or names the branch alongside the
  repository's actual default. The extra request happens only when a download
  has already failed. (#28)
- **An empty Branch field follows the repository's default branch.** It meant
  the literal string `main`, so a repository whose default is `dev` or `master`
  failed on a configuration that looked complete in the form. A connector left
  on the default also now survives that branch being renamed. (#28)

### Operations

- **New optional environment block: `GITHUB_APP_*` and `API_PUBLIC_URL`.**
  Leaving `GITHUB_APP_ID` empty keeps the picker hidden and every existing
  token-based connector working unchanged — no migration, no action required.
  Deployments that want the picker register a GitHub App and fill the block;
  see `docs/features/30-github-repo-picker.md`. Note `GITHUB_APP_PRIVATE_KEY`
  must be base64 of the PEM, because Compose's `env_file` cannot hold a
  multi-line value.
- **Two new tables**, `github_installations` and `github_user_tokens`. Both are
  created empty; there is no backfill and nothing to run beyond the migration.

## [0.6.1] — 2026-09-17

### Fixed

- **Russian headings have stable anchors again.** Every Cyrillic heading used to
  slugify to nothing, so a Russian page's section links were `section`, `-1`,
  `-2` — and retargeted whenever a heading was inserted above. Anchors are now
  built from the heading text in any script. Existing deep links into Russian
  sections change once.
- **Russian PDFs no longer keep hyphenation breaks.** A word split across lines
  in a justified Russian PDF («информа-ция») was imported as two fragments and
  was unfindable; it is now rejoined the way Latin text already was.
- **AI skill triggers written in Russian match whole words.** A trigger like
  «релиз» fired inside «релизный»; the boundary test is now Unicode-aware.
- **Auto-started workflow runs and scheduled agent runs are written in the
  owner's language.** Both defaulted to English regardless of the workspace,
  so an auto-triggered chain in a Russian workspace generated English pages and
  the nightly curator reported in English. Manually started runs were unaffected.
- **Glossary suggestions on a page in another language are no longer dropped.**
  The glossarist was told to write in the page's language and, a line later, in
  the reader's; when it translated the term, the verbatim-occurrence check
  discarded every suggestion in silence. Terms are now always copied from the
  page verbatim; the definition follows the reader's language.
- **Reviewer and glossarist run summaries, warnings and the "assistant
  disabled" reply are translated.** They were hardcoded English, and the
  disabled reply was persisted into the chat thread that way.
- **Russian counts above 100 are declined correctly.** 111 and 212 read as
  «111 страница» / «212 страницы»; the plural rule now looks at the last two
  digits.
- **Review severity badges show a translated label** instead of the raw
  `error` / `warning` / `suggestion` value.

### Added

- `docs/architecture/` — nine per-layer implementation documents for the machinery
  that belongs to no single feature: entrypoints and module boundaries, persistence
  and revisions, ingestion, search and graph, merge and review, auth and ACLs, the
  generated client and error contract, events and live updates, and the web
  frontend. Where the code has diverged from `plan.md` they say so, rather than
  letting the design document quietly stop being true.
- `docs/features/27-comment-editing.md`, documenting comment editing and the
  Comment vs. Start thread split, which had shipped undocumented — its only record
  was a bullet in `CLAUDE.md`.

### Changed

- **`CLAUDE.md` carries conventions and gotchas only**, as `CONTRIBUTING.md`
  already said it did. The 27 per-feature implementation narratives moved into
  `docs/features/` and the new `docs/architecture/` layer, leaving a pointer table;
  the cross-cutting rules that were buried inside them are collected under a new
  **Conventions** section. Several claims were corrected against the code on the
  way out: the glossary word boundary, a `MarkdownView` glossary prop that no
  longer exists, comment reply nesting, the connector table count, and the
  built-in agent roster.
- `docs/README.md` indexes all 27 feature docs and the architecture set; it
  previously stopped at 17 and listed feature 16 as undocumented although its doc
  was sitting next to it.

## [0.6.0] — 2026-09-16

### Added

- **A background agent run says what it is doing while it does it.** A running
  agent now shows the step it is on and how far in it is, and lists anything that
  degraded without failing the run — a page it could not read, a graph store that
  was down — instead of showing nothing until it finished. The list refreshes on
  its own while work is in flight.
- **A finding can cite a page on the web.** Until now a finding that named no
  page in the workspace was discarded, so anything grounded off-platform was
  thrown away in silence. Web citations render as the same chips the assistant
  cites with, and carry through to the draft when you propose a fix.

### Fixed

- **A long agent run is no longer run twice.** Any run still going after half an
  hour was presumed dead and started again, paying for a second set of model
  calls — and whichever copy finished last overwrote the other's result. Runs now
  report as they go, so a slow one is not mistaken for a dead one, and a run that
  has been superseded discards its own result rather than overwriting the run
  that replaced it.
- **The published API description declares the right version** (it said `0.2.0`),
  along with a tool-budget limit that had moved without the description being
  regenerated.

### Changed

- **The assistant fetches several sources at once.** When a turn asks for several
  searches or web pages in one round, they are retrieved together rather than one
  after another, which is where turns that read a lot of the web spent most of
  their time. Actions that change something still run one at a time, so Stop
  continues to stop before anything is created.

### Operations

- One migration (`20260916103000_agent_run_progress`) adds three nullable columns
  to `agent_runs`. Additive only, and runnable by the previous release's image —
  no expand/contract sequencing needed.

## [0.5.0] — 2026-09-16

### Added

- **A shared page layout.** Every screen except the sign-in cards is now one of
  four shapes — something you read, a list, a subject with a rail of facts
  beside it, or a surface that owns the window — so the title, the controls and
  the state of a page sit in the same place on all of them. (#17)
- **Tab strips answer to the keyboard.** Arrow keys move between tabs, `Home`
  and `End` jump to the ends, the strip takes one tab stop instead of one per
  tab, and each tab names the panel it controls for a screen reader. Five pages
  had hand-written strips and none of them did any of this. (#17)
- **A page's rail remembers what you keep open.** Opening History or Changes on
  one page leaves it open on the next for the rest of the session, rather than
  collapsing back to Overview every time you open a page. (#17)
- **The assistant can read PDFs it finds on the web.** A link to a standard, a
  whitepaper or a spec used to be refused outright — the one format a research
  question lands on most. Headings are reconstructed from font size, the same
  way an imported PDF's are, and a scanned PDF now says it is scanned rather
  than arriving as a document that appears to say nothing. (#18)
- **Web citations carry an author and a publication date** where the page
  declares them, so an answer can say how old a source is instead of only where
  it lives. (#18)

### Changed

- **A column that fills the window now measures the header above it instead of
  assuming it.** Side rails subtracted a fixed topbar-plus-breadcrumb height,
  but the breadcrumb strip only appears on screens that have a trail. Every
  screen using it happened to have one, so nothing looked wrong — the next one
  would have run 36px past the bottom of the window with nothing in the code to
  explain why. (#17)
- **Page titles are one size.** Workflows and the pages index showed their
  titles smaller than a settings subpage; sixteen heading styles are now one. (#17)
- **Empty, loading, failed and no-access states share one anatomy** instead of
  eight hand-built variants, and being unable to edit something now reads as a
  statement about your role rather than as an error. (#17)
- **A fetched web page is now scored for its article rather than stripped by tag
  name.** Sidebars, related-article rails, comment sections and cookie-notice
  remnants reached the assistant as though they were the page, because none of
  them sits inside `nav`, `header`, `footer` or `aside`. A page that yields
  almost nothing now says so, instead of being answered from confidently. (#18)

## [0.4.0] — 2026-09-16

### Added

- **The background agents can now read while they work.** The four read-only
  tools — `search_knowledge`, `read_document`, `explore_document_graph` and the
  new `list_relations` — moved into a service the worker can load, so the curator
  opens pages before judging them. It used to decide whether two pages duplicated
  or contradicted each other from a listing of ids, titles and dates, which
  cannot answer that question: "Deploys" and "Release process" are either the
  same page written twice or two different pages, and only their contents say
  which. A model without tool support still runs the previous single-shot pass
  rather than being skipped entirely.
- `list_relations`, a fourth read-only tool, listing a page's relations.

### Changed

- **The assistant's tool budget now defaults to 24 calls per question, up from
  6**, and its ceiling rises from 16 to 64. Six was spent by a single real
  question on search → read ×2 → explore → `list_relations`, after which the
  model had to answer from half the evidence it had asked for. **This increases
  model spend per question**; set `ASSISTANT_MAX_TOOL_CALLS=6` to keep the
  previous behaviour.

### Fixed

- Pasting a long page, writing a long comment or submitting a large import no
  longer fails with an untranslated 500. Request bodies were silently capped at
  Express's 100 kB default; the cap is now configurable, starts at 2 MB, and an
  oversize body comes back as a translated error instead of a crash inside the
  body parser.

### Operations

- New env var **`HTTP_BODY_LIMIT`** (default `2mb`) caps JSON and urlencoded
  request bodies. It has a default, so no action is required to deploy — set it
  only to raise or lower the cap. It counts **bytes, not characters** (Cyrillic
  is two bytes each), so keep it comfortably above the per-field length limits.
- `ASSISTANT_MAX_TOOL_CALLS` changes default from 6 to 24. An install that never
  set it explicitly will spend more per assistant question after this release.

## [0.3.0] — 2026-09-16

### Added

- **Documentation can be derived from a codebase.** A new `codebase` connector
  points at a GitHub or GitLab repository and produces an overview page plus one
  page per module, read from the source rather than mirrored from prose that
  already exists. Module structure comes from the repository's manifests, and
  each page's API surface — exported symbols and their signatures — is extracted
  with tree-sitter. The written summary that opens a page comes from the
  workspace's `author` agent and is optional: with no AI provider configured, no
  owner to bill or no budget left, the pages still arrive with the extracted
  facts and a warning saying which. Re-syncing a repository whose source has not
  changed makes no AI calls at all.

### Fixed

- Connectors, AI plugins and web research could reach no external host at all on
  Node 24 and Node 25, reporting `could not reach <url>` for every request. The
  guarded HTTP client drove a dispatcher from this repository's `undici` with the
  `fetch` built into Node, and those two only interoperate when the running Node
  happens to bundle a matching `undici` generation.

## [0.2.0] — 2026-09-15

### Breaking

- `PATCH /v1/workflows/runs/:id/nodes/:nodeId` now validates `draft.relations`
  element by element: each entry needs a `type` from the relation allowlist and a
  `target.key`. `HTTP`
  **Migration:** send each entry as
  `{ "type": "IMPLEMENTS", "target": { "type": "service", "key": "service:identity" } }`,
  or omit `relations` entirely. The field previously accepted any array and was
  ignored by every executor, so a client that never sent it is unaffected.

### Added

- **The assistant can maintain a page's relations.** Ask it to connect or
  disconnect two pages and it edits the page's own frontmatter and opens a merge
  request — it never changes a live page. Only `relations:` and `tags:` are
  touched; every other frontmatter key is carried through untouched.
- **Cartographer**, a background agent that proposes the relations a page should
  declare. It reports connections a model inferred from a page's text that the
  page itself never declared — the lowest-trust class there is, replaced on every
  re-index — alongside gaps the pages support but nothing has recorded.
- Findings about missing relations can now be acted on at all. An orphan finding
  could previously only be read: "propose a fix" refused it, because the fix is a
  relation rather than page text. Such findings now carry the relations they
  propose, and **Apply relations** turns one into a merge request.
- Workflow steps propose relations and tags for the pages they draft, and the
  review panel shows them — so a generated page's connections are read before
  they are approved rather than discovered afterwards.

### Fixed

- **Editing a page no longer destroys its frontmatter.** Saving in the rich
  editor rebuilt the block from `relations:` and `tags:` alone and silently
  discarded every other key — including `source:`, written by every connector
  adapter, and `glossary: false`, which turns term linking off for a page. This
  affected both creating and editing a page.
- Workflow-generated pages no longer lose the frontmatter their step produced.
  If the drafted body already began with `---`, the whole block was dropped.
- The workflow canvas offers every relation type the graph accepts. It listed
  five of eight, and a chain naming one of the other three was silently rewritten
  to `IMPLEMENTS`. An unrecognised type is now refused in the editor, where it can
  still be corrected, instead of failing when the page is finally published.

### Changed

- A relation change shows some incidental reformatting of neighbouring
  frontmatter keys in its merge-request diff — rewriting the block re-serializes
  all of it. Keys and values are unchanged; comments and quoting style are not
  preserved. The merge request says so.

## [0.1.0] — 2026-09-15

### Added

- Versioning policy, changelog, contribution rules and a tag-triggered release
  flow (`docs/versioning.md`, `CONTRIBUTING.md`, this file).
- Conventional Commits enforced on every commit by a `commit-msg` hook.

### Changed

- **`main` no longer deploys.** `deploy.yml` triggers on `v*.*.*` tags instead of
  on push, so merging integrates and tagging releases.
- Images are now tagged with the release version alongside the commit SHA, making
  a rollback `docker tag knowledge-api:vX.Y.Z knowledge-api:latest` + `compose up -d`.

### Fixed

- **Merge requests no longer deadlock.** Every `POST /v1/merge-requests/:id/merge`
  hung until its connection died, and each retry wedged another pair of connections
  until the pool starved and the API had to be replaced. A raw `$transaction` inside
  an open `withTransaction` boundary does not join it — it opens a second
  transaction on a second pooled connection — so creating the merge revision (whose
  foreign key needs a `KEY SHARE` lock) and advancing the branch head both waited on
  a `document_branches` row the outer connection held `FOR UPDATE`. Postgres saw the
  outer session as `idle in transaction` rather than blocked, so its deadlock
  detector never fired. The same change stops document import and connector staging
  from committing inner work when their outer boundary rolls back. (#7)
- Documents no longer fail to index on a newly deployed instance. Every upload
  stayed unsearchable: the graph store rejected the schema the worker creates at
  startup, and each ingestion job then failed with `Type with name 'Chunk' was not
found`. A worker that cannot create its graph schema now refuses to start
  instead of accepting work it will fail indefinitely. (#4)

### Operations

- The `production` GitHub environment needs a **tag** deployment policy for `v*`:
  a branch-only policy does not match a tag ref, so every tag deploy fails closed
  at the environment gate. Already added on the current deployment; any new
  environment needs it before its first release.
- **Databases created before this release need a one-time ArcadeDB repair.** The
  corrected `defaultDatabases` grant only takes effect when the database is first
  created, so an existing one keeps the broken grant and keeps refusing schema
  changes. With the container stopped, set that database's entry for the ArcadeDB
  user to `["admin"]` in `server-users.jsonl` (in the server's `config` volume),
  start it, restart the worker so the schema is created, then re-queue the failed
  documents with `POST /v1/ingestion/reindex`. A fresh deployment needs none of
  this.
- The "main protection" ruleset still allows `merge` and `rebase` alongside
  `squash`. Narrowing `allowed_merge_methods` to `["squash"]` makes the
  squash-only rule enforced rather than conventional.

### Platform baseline

Everything in this subsection was already serving traffic at
`knowledge.hrustalq.dev` before tagging began; `v0.1.0` is the first tag to name
it.

- **Platform core (plan.md phases 0–5)** — three-store separation across
  PostgreSQL (transactional truth), MinIO (raw bytes) and ArcadeDB (graph +
  vectors); the `Workspace > Project > Document` containment model; the
  outbox-driven ingestion pipeline and its BullMQ worker; an immutable revision
  DAG with branches, compare and merge requests; deterministic and LLM-inferred
  relation extraction; hybrid vector + BM25 search with graph expansion; and
  Phase 5 governance — auth, ACLs, audited operator graph queries, stale-document
  detection and historical fact queries.
- **Product features 01–26** — document view, search, editor, live dependent
  reindex, revision viewer, graph view, categorisation, nesting, AI assistant,
  activity feed, projects, per-workspace AI settings, review mode, glossary, page
  comments, import, dynamic workflows, internationalisation (en/ru), connectors,
  agents, agent mentions, notifications, identity and avatars, the project page,
  web research, and connector staging. Each is documented in
  [`docs/features/`](docs/features/).
- **Four entrypoints** — the HTTP API, the ingestion worker, an MCP server over
  stdio serving `knowledge_*` tools, and the OpenAPI schema generator.
- **Production deployment** — self-hosted runner, Docker Compose stack behind
  Caddy, `prisma migrate deploy` on rollout, health gating on loopback and on the
  public endpoint.

[unreleased]: https://github.com/hrustalq/knowledge/compare/v0.32.1...HEAD
[0.32.1]: https://github.com/hrustalq/knowledge/compare/v0.32.0...v0.32.1
[0.32.0]: https://github.com/hrustalq/knowledge/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/hrustalq/knowledge/compare/v0.30.1...v0.31.0
[0.30.1]: https://github.com/hrustalq/knowledge/compare/v0.30.0...v0.30.1
[0.30.0]: https://github.com/hrustalq/knowledge/compare/v0.29.1...v0.30.0
[0.29.1]: https://github.com/hrustalq/knowledge/compare/v0.29.0...v0.29.1
[0.29.0]: https://github.com/hrustalq/knowledge/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/hrustalq/knowledge/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/hrustalq/knowledge/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/hrustalq/knowledge/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/hrustalq/knowledge/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/hrustalq/knowledge/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/hrustalq/knowledge/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/hrustalq/knowledge/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/hrustalq/knowledge/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/hrustalq/knowledge/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/hrustalq/knowledge/compare/v0.19.1...v0.20.0
[0.19.1]: https://github.com/hrustalq/knowledge/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/hrustalq/knowledge/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/hrustalq/knowledge/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/hrustalq/knowledge/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/hrustalq/knowledge/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/hrustalq/knowledge/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/hrustalq/knowledge/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/hrustalq/knowledge/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/hrustalq/knowledge/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/hrustalq/knowledge/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/hrustalq/knowledge/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/hrustalq/knowledge/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/hrustalq/knowledge/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/hrustalq/knowledge/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/hrustalq/knowledge/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/hrustalq/knowledge/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/hrustalq/knowledge/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/hrustalq/knowledge/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/hrustalq/knowledge/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hrustalq/knowledge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hrustalq/knowledge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hrustalq/knowledge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hrustalq/knowledge/releases/tag/v0.1.0
