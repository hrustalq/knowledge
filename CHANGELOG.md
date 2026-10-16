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

[unreleased]: https://github.com/hrustalq/knowledge/compare/v0.24.0...HEAD
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
