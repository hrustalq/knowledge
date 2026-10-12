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

[unreleased]: https://github.com/hrustalq/knowledge/compare/v0.17.0...HEAD
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
