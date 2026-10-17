import { z } from 'zod';

/**
 * An env flag, spelled out.
 *
 * NOT `z.coerce.boolean()`: that is `Boolean(input)`, and every value here
 * arrives from a .env file as a string, so `FLAG=false` coerced to **true**.
 * The three `*_ALLOW_PRIVATE_URLS` SSRF guards and `AGENT_SCHEDULE_ENABLED`
 * all ship `=false` in .env.example, so copying it armed exactly what it
 * looked like it was disarming.
 *
 * An unrecognised spelling fails boot rather than picking a side — the same
 * fail-fast contract as the rest of this schema. Guessing is how the bug got
 * here in the first place.
 */
const boolish = (fallback: boolean) =>
  z
    .union([
      z.boolean(),
      z.enum(['true', '1', 'yes', 'on']).transform(() => true),
      z.enum(['false', '0', 'no', 'off']).transform(() => false),
    ])
    .default(fallback);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  /**
   * Max size of a JSON/urlencoded request body.
   *
   * Express's own default is 100 kB, which this app silently inherited: a
   * pasted page, a long comment or an import submit died inside body-parser as
   * an untranslated 500 that never mentioned size. Sits above the DTO
   * @MaxLength caps on purpose, so oversize arrives as a translated
   * VALIDATION_FAILED and 413 stays a pure safety net.
   *
   * Note the units differ: @MaxLength counts UTF-16 code units, this counts
   * BYTES, and Cyrillic is 2 bytes/UTF-8 — never derive one from the other as
   * if 1 char = 1 byte. Must keep a default: generate-openapi.main.ts runs this
   * schema with no infra. Accepts anything `bytes` parses ('2mb', '512kb').
   */
  HTTP_BODY_LIMIT: z.string().min(1).default('2mb'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: boolish(true),
  /**
   * Origin the browser reaches object storage at, when it differs from
   * S3_ENDPOINT (#144). Production talks to `http://minio:9000` over the Docker
   * network, a host no browser can resolve; presigned URLs are signed for this
   * origin instead, and the reverse proxy routes `/${S3_BUCKET}/*` to MinIO.
   * Empty = presign against S3_ENDPOINT, which is right whenever the API and the
   * browser share one (dev: http://localhost:9000).
   */
  S3_PUBLIC_ENDPOINT: z.string().optional().default(''),

  ARCADE_URL: z.string().min(1),
  ARCADE_DB: z.string().min(1),
  ARCADE_USER: z.string().min(1),
  ARCADE_PASSWORD: z.string().min(1),

  EMBEDDINGS_PROVIDER: z.enum(['stub', 'openai-compatible']).default('stub'),
  EMBEDDINGS_BASE_URL: z.string().optional().default(''),
  EMBEDDINGS_MODEL: z.string().optional().default(''),
  EMBEDDINGS_API_KEY: z.string().optional().default(''),
  EMBEDDINGS_DIM: z.coerce.number().default(384),

  /** Phase 4 LLM relation extraction — 'none' keeps the pipeline dependency-free. */
  EXTRACTOR_PROVIDER: z.enum(['none', 'openai-compatible']).default('none'),
  EXTRACTOR_BASE_URL: z.string().optional().default(''),
  EXTRACTOR_MODEL: z.string().optional().default(''),
  EXTRACTOR_API_KEY: z.string().optional().default(''),
  EXTRACTOR_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
  EXTRACTOR_MAX_CHUNKS: z.coerce.number().int().positive().default(20),

  /** Phase 5 auth: 'none' = dev principal with full access (Phase 0-4 flows keep working); 'api-key' = Bearer auth (kn_ API keys AND ks_ login session tokens). */
  AUTH_MODE: z.enum(['none', 'api-key']).default('none'),
  /** Auth flow: login session lifetime. */
  AUTH_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),
  /** Auth flow: password-reset token lifetime. */
  AUTH_RESET_TTL_MIN: z.coerce.number().int().positive().default(30),
  /**
   * #102 phase 2: lifetime of a single-use `kt_` URL ticket (POST /v1/auth/url-ticket),
   * the credential the web puts in `?token=` for SSE and <img>/<object> routes.
   */
  AUTH_URL_TICKET_TTL_SEC: z.coerce.number().int().min(5).max(3600).default(60),
  /** Auth flow: allow self-service POST /v1/auth/signup. */
  AUTH_SIGNUP_ENABLED: boolish(true),
  /** Workspace new signups auto-join (empty disables). Defaults to the demo workspace. */
  AUTH_DEFAULT_WORKSPACE_ID: z.string().default('11111111-1111-4111-8111-111111111111'),
  AUTH_DEFAULT_ROLE: z.enum(['viewer', 'editor', 'admin']).default('viewer'),
  /** Public base URL of the web app — every link a mail carries is built on it (docs/features/41). */
  WEB_BASE_URL: z.string().default('http://localhost:5173'),
  /** Lifetime of a `kv_` email-verification link. */
  AUTH_VERIFY_TTL_HOURS: z.coerce.number().int().positive().default(48),
  /** Lifetime of an invite (a `kr_` token with purpose 'invite') — longer than a reset, nobody asked for it. */
  AUTH_INVITE_TTL_HOURS: z.coerce.number().int().positive().default(72),
  /**
   * Refuse session principals whose address is unproven (403 `emailUnverified`)
   * everywhere but the routes that let them prove it. Off by default: an
   * unverified person can work and is nagged by a banner. API keys are minted
   * by an admin and are never refused for this.
   */
  AUTH_REQUIRE_VERIFIED_EMAIL: boolish(false),

  /**
   * Mailer (docs/features/41). `log` writes each message to the worker log and
   * sends nothing — the default, so dev and CI never open a socket. `smtp`
   * sends through MAIL_SMTP_URL (`smtp://` STARTTLS or `smtps://` implicit TLS),
   * which any provider accepts. Credentials go either in the URL's userinfo,
   * URL-encoded, or in MAIL_SMTP_USER / MAIL_SMTP_PASS verbatim — never both.
   */
  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  MAIL_SMTP_URL: z.string().default(''),
  /** SMTP auth beside a credential-free MAIL_SMTP_URL, so the URL can be a plain variable. */
  MAIL_SMTP_USER: z.string().default(''),
  MAIL_SMTP_PASS: z.string().default(''),
  /** RFC 5322 From — the domain is the one SPF/DKIM must be set up for. */
  MAIL_FROM: z.string().default('Knowledge <no-reply@localhost>'),
  /** Operator switch for notification mail; auth mail is unaffected. */
  MAIL_NOTIFICATIONS_ENABLED: boolish(true),

  /** Phase 5 optional BM25 layer (plan.md §11) — 'none' keeps search vector-only. */
  FULLTEXT_PROVIDER: z.enum(['none', 'opensearch']).default('none'),
  OPENSEARCH_URL: z.string().optional().default('http://localhost:9200'),
  OPENSEARCH_INDEX: z.string().optional().default('knowledge-chunks'),
  /**
   * How long a search waits for the BM25 leg (#173). Past it, or on any error,
   * the search answers from vectors alone and says `degraded: ['fulltext']`.
   */
  FULLTEXT_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),

  /** Phase 5 stale-doc detection & reindex scheduling (worker sweeper). */
  STALE_SWEEP_ENABLED: boolish(true),
  /**
   * Permission-aware retrieval (#76). A caller's hidden (member) or reachable
   * (guest) page list goes to ArcadeDB and OpenSearch as a predicate up to this
   * length; past it the stores filter what they scanned in memory instead.
   */
  ACL_DENY_LIST_MAX: z.coerce.number().int().min(0).default(5000),
  /** Candidate multiplier when a caller's restrictions could not be pushed into the stores. */
  SEARCH_ACL_OVERFETCH: z.coerce.number().int().min(1).default(5),
  /** Cap on candidates per leg for the one refill round after the permission post-filter. */
  SEARCH_ACL_MAX_FETCH: z.coerce.number().int().positive().default(500),
  /** Worker tick that copies changed page restrictions onto chunk stamps in ArcadeDB/OpenSearch. */
  ACL_RESTAMP_TICK_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Pages re-stamped per tick. */
  ACL_RESTAMP_BATCH: z.coerce.number().int().positive().default(200),
  /**
   * How long a live connection (SSE/WS) trusts the visibility it computed for
   * its holder (#76) before asking PG again. An `acl.changed` event clears it
   * at once; this bounds what a missed one costs.
   */
  ACL_CACHE_TTL_MS: z.coerce.number().int().min(0).default(5000),
  /** Days a pending access request waits on a manager before it expires (#76). */
  ACCESS_REQUEST_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * Page verification and knowledge health (docs/features/39 + 40, issue #66).
   * Defaults, not ceilings: a `knowledge_health_settings` row overrides each
   * per workspace, and an absent row reproduces exactly these values.
   */
  /** Days a stamp holds before it reads `expired`; 0 = never. */
  VERIFICATION_DEFAULT_REVIEW_DAYS: z.coerce.number().int().min(0).default(90),
  /** How long before expiry the owner is reminded. */
  VERIFICATION_REMIND_BEFORE_DAYS: z.coerce.number().int().min(0).default(7),
  /** No write, comment or verification for this long and a page reads `inactive`; 0 disables. */
  PAGE_INACTIVE_AFTER_DAYS: z.coerce.number().int().min(0).default(180),
  /** A head revision whose body (without frontmatter) is at most this long is an empty page. */
  EMPTY_PAGE_MAX_CHARS: z.coerce.number().int().min(0).default(40),
  /** The API-side sweeper that reminds, expires and fills `body_chars` for legacy revisions. */
  VERIFICATION_SWEEP_ENABLED: boolish(true),
  /** Kill switch for the trust re-rank in search; false restores the pre-#66 order exactly. */
  SEARCH_TRUST_RANKING: boolish(true),
  /**
   * AI-readable output (issue #68): `GET /v1/documents/:id/markdown` and
   * `Accept: text/markdown` on `/content`. Kill switch — false 404s the routes
   * and `/content` stays JSON-only.
   */
  AI_READABLE_ENABLED: boolish(true),
  /**
   * Share links (docs/features/43, issue #77). PUBLIC_SHARING_ENABLED is the
   * ceiling over every workspace's `publishing_settings` switch: false refuses
   * new links and 404s every existing one, whatever the workspace says.
   */
  PUBLIC_SHARING_ENABLED: boolish(true),
  /** Longest a share link may live, in days; a longer or never-expiring request is cut to it. 0 = no cap. */
  SHARE_LINK_MAX_TTL_DAYS: z.coerce.number().int().min(0).default(0),
  /** How long a password-unlocked share stays open in one browser. */
  SHARE_UNLOCK_TTL_MIN: z.coerce.number().int().positive().default(720),
  /** Per-IP requests a minute across the anonymous /v1/public routes. */
  PUBLIC_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  /** Password attempts per IP and link in 15 minutes before the unlock answers 429. */
  PUBLIC_UNLOCK_ATTEMPTS_PER_15MIN: z.coerce.number().int().positive().default(10),
  /**
   * Published sites (docs/features/44, issue #77). PUBLIC_SITES_ENABLED is the
   * ceiling over the workspace's `allow_public_sites` switch: false refuses to
   * publish and 404s every live site.
   */
  PUBLIC_SITES_ENABLED: boolish(true),
  /**
   * Sites are served at `<slug>.<PUBLISH_BASE_DOMAIN>`. Empty = path mode,
   * `${WEB_BASE_URL}/pub/<slug>`. The web SSR reads the same variable.
   */
  PUBLISH_BASE_DOMAIN: z
    .string()
    .default('')
    .transform((v) => v.trim().toLowerCase().replace(/^\.+|\.+$/g, '')),
  /** How long a live version waits after a change before it rebuilds; later changes in the window ride along. */
  SITE_BUILD_DEBOUNCE_MS: z.coerce.number().int().min(0).default(30_000),
  /** Most pages one site version publishes; the rest is cut and the build says so. */
  SITE_MAX_PAGES: z.coerce.number().int().positive().default(2000),
  /**
   * Whether sites may answer on their own hostnames (issue #77 phase 2b). The
   * front proxy must route those hosts here and terminate TLS for them (Caddy
   * on-demand TLS, see Caddyfile.sites.example). false: admins are told so,
   * adding a domain is refused, and no custom hostname resolves.
   */
  SITE_CUSTOM_DOMAINS: boolish(true),
  /**
   * How long a site sign-in lasts (issue #77 phase 3): a workspace member's
   * through the app, or a visitor's through a customer-signed JWT, which is
   * also held to the token's own `exp`.
   */
  SITE_VISITOR_TTL_MIN: z.coerce.number().int().positive().default(1440),
  /**
   * Ask on published sites (issue #77 phase 3): the most answers one site may
   * give a day. A ceiling over each site's own budget, not only its default;
   * 0 turns Ask off everywhere.
   */
  PUBLIC_ASK_DAILY_BUDGET: z.coerce.number().int().min(0).default(200),
  /** Questions per minute from one address, across every site. */
  PUBLIC_ASK_RATE_PER_MIN: z.coerce.number().int().positive().default(6),
  /** Tick of PublishingSweeper: pending domain checks and lost site builds. */
  PUBLISHING_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Export (issue #77 phase 2c, docs/features/45). PDF goes through a Gotenberg
   * sidecar's Chromium (`make infra-up-gotenberg`); empty = no PDF, and the
   * dialog says why. ZIP and HTML need nothing beyond the worker.
   */
  GOTENBERG_URL: z.string().default(''),
  /**
   * Where the worker reaches the web server, which renders an export's HTML
   * with the reader's own parser (`POST /_internal/export/render`). In compose
   * that is the web service by name, not WEB_BASE_URL.
   */
  WEB_INTERNAL_URL: z.string().default('http://localhost:5173'),
  /** Most pages one export may hold; a larger request is refused before it is queued. */
  EXPORT_MAX_PAGES: z.coerce.number().int().positive().default(500),
  /** Most bytes one export may hold — sources, attachments and the file written (256 MB). */
  EXPORT_MAX_BYTES: z.coerce.number().int().positive().default(268_435_456),
  /** How long a finished export can be downloaded before its file is deleted. */
  EXPORT_TTL_HOURS: z.coerce.number().int().positive().default(72),
  /** Exports one worker builds at once. */
  EXPORT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** Wall-clock ceiling for rendering and converting one export; past twice this the sweeper fails it. */
  EXPORT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** Cap on pages in one llms-full.txt; past it the dump ends with a truncation marker. */
  LLMS_FULL_MAX_DOCS: z.coerce.number().int().positive().default(2000),
  /** Cap on bytes streamed in one llms-full.txt (20 MB). */
  LLMS_FULL_MAX_BYTES: z.coerce.number().int().positive().default(20_000_000),
  /** Parallel S3 reads while streaming llms-full.txt. */
  AI_READABLE_FETCH_CONCURRENCY: z.coerce.number().int().positive().default(8),
  // Background agent schedules (docs/features/20). Off by default: the failure
  // mode of unattended AI is an avalanche, not a slow queue.
  AGENT_SCHEDULE_ENABLED: boolish(false),
  // Event-triggered agent runs (#70). The kill switch for the listener, off by
  // default for the same reason; a trigger is also off until an admin enables it.
  AGENT_TRIGGERS_ENABLED: boolish(false),
  /** Triggered runs one workspace may have pending or running at once. */
  AGENT_TRIGGER_MAX_ACTIVE: z.coerce.number().int().min(0).default(5),
  /** The cooldown a new trigger starts with, per subject. The trigger's own column decides after that. */
  AGENT_TRIGGER_COOLDOWN_MINUTES: z.coerce.number().int().min(0).max(10_080).default(60),
  /**
   * Largest body a signed agent-trigger webhook accepts, in bytes (#70). Below
   * HTTP_BODY_LIMIT on purpose: a run keeps only AGENT_WEBHOOK_PAYLOAD_MAX_CHARS
   * of it, and an unauthenticated caller should not get to make the API hash
   * two megabytes. Checked before the signature.
   */
  AGENT_WEBHOOK_MAX_BYTES: z.coerce.number().int().positive().default(65_536),
  /** How far `X-Knowledge-Timestamp` may be from the server's clock — the replay window. */
  AGENT_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  /**
   * Active learnings one prompt takes, newest first (#70). Bounded so a team's
   * corrections cannot quietly eat the context window documents need.
   */
  AGENT_LEARNINGS_MAX: z.coerce.number().int().min(0).max(100).default(20),
  /**
   * Re-read a repository connector's AGENTS.md / CLAUDE.md / .cursorrules…
   * after each successful sync (#70). On by default: an import only ever
   * creates DISABLED skills, and an enabled one's text changes only when an
   * admin accepts the upstream diff. Off leaves the connector page's Import.
   */
  REPO_GUIDANCE_IMPORT_ENABLED: boolish(true),
  STALE_INDEXING_TIMEOUT_MIN: z.coerce.number().int().positive().default(15),
  STALE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /**
   * Feature 09 AI assistant (docs/features/09) — 'none' disables the LLM endpoints.
   * All non-none providers use the official `openai` SDK. `deepseek` and
   * `gen-api` are named shorthands that only pre-fill BASE_URL/MODEL from
   * PROVIDER_DEFAULTS — https://api.deepseek.com and
   * https://proxy.gen-api.ru/v1 respectively. gen-api.ru is an aggregator, so
   * one credential reaches GPT, Claude and Gemini models by id.
   */
  ASSISTANT_PROVIDER: z.enum(['none', 'openai-compatible', 'deepseek', 'gen-api']).default('none'),
  ASSISTANT_BASE_URL: z.string().optional().default(''),
  ASSISTANT_MODEL: z.string().optional().default(''),
  ASSISTANT_API_KEY: z.string().optional().default(''),
  /**
   * Tool harness: max tool executions per /v1/assistant/ask request (0 = plain chat).
   *
   * Was 6, which a single real question spent on search -> read x2 -> explore ->
   * list_relations before the harness forced a toolless final round — the model
   * answered from half the evidence it had asked for. MAX_ROUNDS in
   * assistant.client.ts scales off this, so raising it here actually buys rounds.
   */
  ASSISTANT_MAX_TOOL_CALLS: z.coerce.number().int().min(0).max(64).default(24),
  /** Upstream request timeout for the assistant provider. */
  ASSISTANT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * A cited page whose head changed longer ago than this counts as stale
   * evidence in the answer's confidence (docs/features/38). Confidence only —
   * nothing is hidden or re-ranked by it.
   */
  ANSWER_STALE_SOURCE_DAYS: z.coerce.number().int().positive().default(180),
  /**
   * Votes and implicit low-confidence signals on answers (docs/features/38,
   * phase 2). Off: the vote routes and knowledge_feedback refuse, and the
   * harness records no signals. A master switch for an operator who does not
   * want question text in PostgreSQL at all.
   */
  ANSWER_FEEDBACK_ENABLED: boolish(true),
  /**
   * Feedback rows and closed knowledge issues older than this are purged by
   * the report sweeper's retention tick (docs/features/38, phase 3). Stored
   * question text is user content and must not live forever.
   */
  ANSWER_FEEDBACK_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
  /** Knowledge issues one principal (per API key when present) may file per 24 h; past it a report is 429. */
  KNOWLEDGE_ISSUE_DAILY_LIMIT: z.coerce.number().int().positive().default(50),
  /**
   * Sentinel report checks one workspace may have waiting. Past this a report
   * stays `open` for a person instead of queueing a model run — the
   * DriftTriggerService MAX_PENDING rule, made an env var.
   */
  KNOWLEDGE_ISSUE_MAX_PENDING_CHECKS: z.coerce.number().int().positive().default(10),
  /**
   * The surveyor (docs/features/38, phase 4): how far back a run reads answer
   * feedback, the smallest cluster it reports, the cosine threshold two
   * questions must clear to be one topic, and the most signals one run reads.
   */
  COVERAGE_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  COVERAGE_MIN_CLUSTER_SIZE: z.coerce.number().int().min(1).default(3),
  COVERAGE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.82),
  COVERAGE_MAX_QUESTIONS: z.coerce.number().int().positive().default(2_000),
  /**
   * Styleguides (#74): the most rules one styleguide may hold — every rule is
   * in every lint prompt, so this bounds the prompt — and the most violations
   * one lint reports, so a long page cannot bury its reader.
   */
  STYLEGUIDE_MAX_RULES: z.coerce.number().int().positive().default(50),
  LINT_MAX_FINDINGS: z.coerce.number().int().positive().default(15),
  /**
   * The style lint of merge requests (#74, phase 2): the ceiling of every
   * workspace's and project's lint policy, and the policy of one that sets
   * none. `off` (the default) lints nothing anywhere. A scope may ask for a
   * narrower policy, never a wider one (off < warn < block). `block` lets the
   * merge gate hold a merge request while the check of its head is to come or
   * found an unresolved error-severity violation (phase 3).
   */
  STYLE_LINT_POLICY: z.enum(['off', 'warn', 'block']).default('off'),
  /** Lint checks one workspace may have waiting; past it a head waits for the next tick. */
  LINT_MAX_PENDING_PER_WORKSPACE: z.coerce.number().int().positive().default(20),
  /**
   * The quality auditor (#74, phase 4): the most pages one run scores (one
   * model call each, unless the page's revision was scored already), how many
   * days a score stands before an unchanged page is re-scored (a workspace may
   * override it in ai_settings), the mean-embedding cosine two pages must clear
   * to be reported as near-duplicates, and the overall score below which a page
   * becomes a finding.
   */
  QUALITY_AUDIT_MAX_PAGES: z.coerce.number().int().positive().default(200),
  QUALITY_AUDIT_DAYS: z.coerce.number().int().positive().default(7),
  QUALITY_DUPLICATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  QUALITY_FINDING_THRESHOLD: z.coerce.number().int().min(0).max(100).default(50),

  /**
   * Feature 12 AI settings: AES-256-GCM key (base64, 32 bytes) for provider
   * credentials stored in ai_settings/ai_plugins. Empty disables secret WRITES
   * (everything else keeps working) rather than failing boot — same fail-soft
   * spirit as ASSISTANT_PROVIDER=none. Generate: openssl rand -base64 32
   */
  SETTINGS_ENCRYPTION_KEY: z.string().optional().default(''),
  /** Feature 12 plugins: allow MCP server URLs on private/loopback ranges (self-hosted). */
  AI_PLUGINS_ALLOW_PRIVATE_URLS: boolish(false),

  /**
   * Web research (docs/features/25): the CEILING on how much of the open web
   * the assistant may reach, not a default.
   *
   * `ai_settings.web_access_mode` is clamped to this rather than inheriting it,
   * because a workspace admin must not be able to switch on the open web in a
   * deployment where that was decided against. Feature 20 already committed to
   * the rule: settings intersect, never union.
   *
   * `off` keeps every existing deployment byte-identical — the two web tools
   * are not offered to the model at all.
   */
  WEB_ACCESS_MODE: z.enum(['off', 'allowlist', 'open']).default('off'),

  /**
   * SearXNG JSON endpoint, e.g. `http://searxng:8080`. Unset means fetching a
   * named URL still works and searching does not.
   *
   * Deliberately a URL rather than a `WEB_SEARCH_PROVIDER` enum: there is one
   * backend, and an enum's `none` would mean "the tools do not exist", which
   * WEB_ACCESS_MODE=off already says in the setting that also says it to the
   * workspace. The interface arrives with the second backend, shaped by what
   * the two actually differ on.
   *
   * NOTE: SearXNG's JSON API is off by default — `formats: [json]` has to be
   * set in its settings.yml or every query comes back as HTML.
   */
  WEB_SEARCH_URL: z.string().optional().default(''),

  /**
   * Ceiling for `ai_settings.external_ai_actions` (issue #68): whether a page's
   * AI actions menu may offer "Open in ChatGPT / Claude / Cursor", which put the
   * page's content into a vendor URL. false removes them for every workspace,
   * whatever the workspace setting says; the admin page shows the clamp.
   */
  AI_EXTERNAL_ACTIONS_ENABLED: boolish(true),

  /**
   * Largest page (in characters) "Open in ChatGPT / Claude / Cursor" puts
   * inline into the vendor URL. A longer page is copied to the clipboard
   * instead, with a toast telling the reader to paste it (issue #68).
   */
  AI_ACTION_INLINE_MAX_CHARS: z.coerce.number().int().positive().default(6000),

  /**
   * Agent-session memory (issue #73): coding agents propose what they learned
   * as merge requests. CAPTURE_ENABLED and the two limits are CEILINGS for the
   * workspace's AI settings — a workspace may ask for less, never more — and
   * the settings page shows both values. The limits are counted over the
   * capture rows themselves, per key per rolling hour and per workspace per
   * rolling day.
   */
  CAPTURE_ENABLED: boolish(true),
  CAPTURE_PER_KEY_PER_HOUR: z.coerce.number().int().min(0).default(30),
  CAPTURE_PER_WORKSPACE_PER_DAY: z.coerce.number().int().min(0).default(500),
  /**
   * Cosine similarity against the nearest page above which a capture is a
   * duplicate candidate, and above which it amends that page instead of
   * starting a new one. Defaults, not ceilings: a workspace tunes them to its
   * embedding model. Raw cosine from the vector leg — not a fused search score.
   * Measured on bge-m3 with `make backtest ARGS="--captures"` (#234); the run
   * and why these values held are in docs/features/50-agent-memory.md
   * §Calibration. Re-run it when the embedding model changes.
   */
  CAPTURE_DEDUPE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  CAPTURE_AMEND_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  /** Longest capture payload, in characters, summed over its text fields. */
  CAPTURE_MAX_CHARS: z.coerce.number().int().positive().default(8000),
  /** The capture sweeper's tick, and how old a claim must be before it re-drives the row. */
  CAPTURE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  CAPTURE_STALE_MS: z.coerce.number().int().positive().default(300_000),

  /**
   * API reference documents (#78). A spec larger than this, or defining more
   * operations, is refused at finalize (422) and at ingestion — the operation
   * count is the graph and projection fan-out of one revision.
   */
  API_SPEC_MAX_BYTES: z.coerce.number().int().positive().default(5_000_000),
  API_SPEC_MAX_OPERATIONS: z.coerce.number().int().positive().default(2000),

  /**
   * The try-it proxy (#78): POST /v1/api-specs/:id/try sends a request to a
   * server the spec names, for an API that does not allow CORS. The mode is a
   * CEILING the workspace setting can only narrow, as WEB_ACCESS_MODE is for
   * web research: `allowlist` reaches only hosts the workspace's source
   * policies allow, `open` any host they do not block. `off` keeps the route
   * refusing and the console browser-direct only.
   */
  API_TRY_PROXY_MODE: z.enum(['off', 'allowlist', 'open']).default('off'),
  /** Let the proxy reach private and loopback addresses (an intranet API). Operator-only. */
  API_TRY_ALLOW_PRIVATE_URLS: boolish(false),
  API_TRY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** A longer response body is cut here and returned with `truncated: true`. */
  API_TRY_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(1_000_000),
  /** Proxied requests per user per minute, counted in Redis. */
  API_TRY_RATE_PER_MINUTE: z.coerce.number().int().positive().default(30),

  /** Allow web targets on private/loopback ranges (self-hosted SearXNG, intranet). */
  WEB_ALLOW_PRIVATE_URLS: boolish(false),

  /** Hard cap on a fetched page before extraction, so one huge URL cannot exhaust the process. */
  WEB_FETCH_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),

  /** Upstream timeout for one search or one page fetch. */
  WEB_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  /** Feature 04: max dependent documents re-indexed per indexed revision (0 disables). */
  DEPENDENT_REINDEX_MAX: z.coerce.number().int().min(0).default(20),

  /**
   * Dynamic workflows (docs/features/17): how many auto-started runs one
   * workspace may have in flight. The cap exists because the failure mode of an
   * event trigger is an LLM avalanche, not a slow queue.
   */
  WORKFLOW_AUTOSTART_MAX_ACTIVE: z.coerce.number().int().min(0).default(5),

  /**
   * How long after a repo-event-triggered run this definition refuses to start
   * another for the same page (docs/features/32).
   *
   * Page events get an absolute "only ever once" guard, because a run's output
   * edits pages and an edit is itself a page event — the chain would feed
   * itself forever. A repo event cannot do that on its own: it is caused by a
   * person on the far side, not by anything this product writes.
   *
   * It is not *quite* impossible, which is why this is a cooldown rather than
   * nothing. A flow that comments on or closes an issue when it finishes makes
   * the far side move, and that comes back as another `repo.*` event. The
   * in-flight guard catches the common shape of that; this bounds the rest.
   */
  WORKFLOW_REPO_RETRIGGER_COOLDOWN_MINUTES: z.coerce.number().int().min(0).default(60),

  /**
   * How long a workflow node may sit claimed (`running`) before the sweeper
   * assumes the worker that took it died and returns it to the queue.
   * Generous by default: a drafting step with tools legitimately takes minutes,
   * and re-queueing a live step means paying for the model call twice.
   */
  WORKFLOW_NODE_STALE_MS: z.coerce.number().int().min(1000).default(15 * 60_000),

  /** Merge gating: approvals required to merge (the author's own approval never counts; 0 disables the gate). */
  MR_REQUIRED_APPROVALS: z.coerce.number().int().min(0).default(1),

  /** Phase 5 trusted-operator graph queries: hard row cap per call. */
  GRAPH_QUERY_MAX_ROWS: z.coerce.number().int().positive().max(1000).default(200),

  /** Rich-editor page attachments: hard per-file ceiling (bytes), enforced at presign and again on confirm. */
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(26_214_400),

  /**
   * Document import (docs/features/16). The ceiling is larger than an
   * attachment's because the thing being uploaded is a whole book of a PDF, not
   * a screenshot; it is enforced at presign and again from the bucket's own
   * HEAD, so a client that lies about `sizeBytes` still cannot get past it.
   */
  IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(52_428_800),
  /** Wall-clock ceiling for one parse, so a pathological file fails instead of pinning a worker. */
  IMPORT_PARSE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Vision-OCR page ceiling — bounds the spend a single scanned PDF can incur. */
  IMPORT_OCR_MAX_PAGES: z.coerce.number().int().positive().default(20),

  /**
   * Connectors (docs/features/19). Allow connector base URLs and git remotes on
   * private/loopback ranges — an on-prem Confluence or a self-hosted GitLab is a
   * legitimate target, but the default refuses them because a URL typed into a
   * settings form is also the classic SSRF shape. Mirrors AI_PLUGINS_ALLOW_PRIVATE_URLS.
   */
  CONNECTOR_ALLOW_PRIVATE_URLS: boolish(false),
  /** Items one sync run will touch, so a 50k-page space cannot pin a worker forever. */
  CONNECTOR_SYNC_MAX_ITEMS: z.coerce.number().int().positive().default(1_000),
  /** Wall-clock ceiling for one sync run. */
  CONNECTOR_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** Worker-side schedule sweeper for connectors with syncIntervalMinutes set. */
  CONNECTOR_SCHEDULE_ENABLED: boolish(true),
  /**
   * Trace the sync (docs/features/26): every upstream request, every level of
   * the tree walk, and the decision taken for each item. Off by default — it is
   * verbose enough to be useless in production, and its whole point is
   * diagnosing "the connector pulled nothing and said nothing".
   */
  CONNECTOR_DEBUG: boolish(false),
  /**
   * Items processed before the run checkpoints and re-enqueues itself. This is
   * what keeps a large space from dying on CONNECTOR_SYNC_TIMEOUT_MS, and it is
   * also how often a pause is noticed.
   */
  CONNECTOR_SYNC_BATCH: z.coerce.number().int().positive().default(25),
  /**
   * Minutes between ACL-only refreshes of a connector that mirrors access
   * (#76), when the connector does not set its own. Permission calls only, no
   * content fetch; a due check inside the schedule sweeper's tick.
   */
  CONNECTOR_ACL_SYNC_DEFAULT_MIN: z.coerce.number().int().positive().default(60),

  /**
   * Code research (docs/features/31). A repository read by the code tools is
   * downloaded once and held in memory: this is how long a snapshot stays
   * fresh, and how much every snapshot in one process may hold together before
   * the least recently used one is dropped. Per process — the API and the
   * worker each keep their own, deliberately, rather than putting a live
   * repository's contents into a second system.
   */
  CODE_SNAPSHOT_TTL_MS: z.coerce.number().int().positive().default(600_000),
  CODE_SNAPSHOT_MAX_BYTES: z.coerce.number().int().positive().default(268_435_456),

  /**
   * Repo wiki (docs/features/46). Both are ceilings, not defaults: a repository's
   * `.knowledge/wiki.yml` or a connector override may ask for less, never more,
   * and the Wiki tab shows what was asked beside what applied.
   */
  WIKI_MAX_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  WIKI_DIAGRAM_MAX_NODES: z.coerce.number().int().min(4).max(200).default(40),
  /** Code-tool calls one wiki section may make at effort `high`; lowers, never raises, the agent's own budget. */
  WIKI_HIGH_EFFORT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(64).default(24),
  /**
   * How long a push-triggered wiki run waits before it starts. Pushes inside
   * the window fold into the same queued run, so a burst of commits is one sync.
   */
  WIKI_PUSH_DEBOUNCE_MS: z.coerce.number().int().min(0).max(3_600_000).default(120_000),
  /** Release notes: tags generated on a connector's first sync — older ones are listed, not generated. */
  CHANGELOG_MAX_RELEASES: z.coerce.number().int().min(1).max(200).default(20),
  /** Commits read per release; a longer range is cut with a warning saying so. */
  CHANGELOG_MAX_COMMITS_PER_RELEASE: z.coerce.number().int().min(1).max(5_000).default(500),

  /**
   * Where this API is reachable from a browser.
   *
   * Distinct from WEB_BASE_URL, which is the SPA. Needed because an OAuth
   * redirect URI has to match the provider's registration byte for byte, so it
   * cannot be derived from the incoming request's Host — behind a proxy that is
   * whatever the proxy chose to forward, and a mismatch fails the exchange with
   * a message that names neither side.
   */
  API_PUBLIC_URL: z.string().default('http://localhost:3000'),

  /**
   * GitHub App backing the repository picker (docs/features/30).
   *
   * Empty GITHUB_APP_ID is the off switch, and it is fail-soft in the same
   * spirit as SETTINGS_ENCRYPTION_KEY='': the picker is not offered, and every
   * connector already configured with a personal access token keeps working
   * byte-identically. Nothing here is required to boot, because
   * generate-openapi.main.ts runs this schema with no infrastructure at all.
   */
  GITHUB_APP_ID: z.string().optional().default(''),
  /** The App's URL slug — `https://github.com/apps/<slug>/installations/new`. */
  GITHUB_APP_SLUG: z.string().optional().default(''),
  GITHUB_APP_CLIENT_ID: z.string().optional().default(''),
  GITHUB_APP_CLIENT_SECRET: z.string().optional().default(''),
  /**
   * The App's private key, used to sign the JWT that mints installation tokens.
   *
   * GitHub issues this as a multi-line PKCS#1 PEM, which a .env file cannot
   * hold: `parsePrivateKey` therefore accepts base64 of the whole PEM (what you
   * want in a secrets manager) and a single line with literal `\n` escapes,
   * as well as a real PEM for the case where this arrives from a file mount.
   */
  GITHUB_APP_PRIVATE_KEY: z.string().optional().default(''),
  /**
   * Shared secret for the App-level webhook (docs/features/32).
   *
   * Separate from every connector's own `webhook_secret`, and deliberately so:
   * that one authenticates a repository hook somebody configured per connector,
   * this one authenticates GitHub itself delivering for the whole installation.
   * One App has one secret, so one env var is the honest shape.
   *
   * Empty is the off switch, matching GITHUB_APP_ID: with no secret the
   * endpoint refuses every delivery rather than trusting an unsigned one.
   */
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional().default(''),
  /** Override for GitHub Enterprise Server. The web UI and OAuth URLs derive from it. */
  GITHUB_API_URL: z.string().default('https://api.github.com'),

  /** Live tracked-entity updates over WebSocket (/v1/events/ws). */
  LIVE_WS_ENABLED: boolish(true),
  /** Server-side tracking configuration: comma-separated event types (exact or 'prefix.*'); '*' broadcasts everything. */
  LIVE_TRACKED_EVENTS: z.string().default('*'),
  /** Max concurrent workspace subscriptions per socket. */
  LIVE_WS_MAX_SUBSCRIPTIONS: z.coerce.number().int().positive().max(64).default(8),

  /**
   * Minimum level written to stdout (stderr in the MCP process, whose stdout is
   * the JSON-RPC transport). Declared here so a typo fails boot, but note the
   * asymmetry: the entrypoints build their logger *before* DI exists, so they
   * read process.env.LOG_LEVEL directly. This schema is the validation for that
   * read, not its source.
   */
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  /**
   * Render records as coloured, human-readable lines instead of JSON.
   *
   * Defaults to on outside production — and, like LOG_LEVEL, the entrypoints
   * read process.env directly because the logger is built before DI exists.
   * Declared here so a typo fails boot rather than silently picking a side.
   */
  LOG_PRETTY: boolish(process.env.NODE_ENV !== 'production'),
  /**
   * Directory for the backtest JSONL stream — one file per service per day.
   *
   * Optional on purpose: unset means <repo root>/logs, resolved from the
   * observability package's own location rather than process.cwd(). The API and
   * the SSR server start in different directories, so a cwd-relative default
   * split a single browser → SSR → API trace across two separate files.
   */
  LOG_DIR: z.string().optional(),
  /**
   * Persist error-level records to ops_events. The stdout stream is unaffected
   * either way; this only controls whether errors are also queryable in SQL.
   */
  OPS_SINK_ENABLED: boolish(true),
  /**
   * Write the backtest event stream (search / ai / ingest) to LOG_DIR. Separate
   * from LOG_LEVEL on purpose: these are measurements, not diagnostics, and a
   * full corpus re-index emits tens of thousands of them.
   */
  OPS_JSONL_ENABLED: boolish(true),

  /**
   * Chat bots (issue #71). Off: the webhook answers 404, settings are still
   * editable so a bot can be prepared, and the reaper does not run.
   */
  CHAT_ENABLED: boolish(false),
  /** A question still unanswered after this long is failed, and its placeholder says so. */
  CHAT_ANSWER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  /** Source links printed under one answer. */
  CHAT_MAX_SOURCES: z.coerce.number().int().min(0).max(10).default(5),
  /** How long a link code sent by the bot stays redeemable. */
  CHAT_LINK_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  /**
   * Questions one person may ask the bots in a minute. A ceiling: the next one
   * gets a "slow down" reply and no model call.
   */
  CHAT_RATE_LIMIT_PER_USER_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /**
   * A saved conversation still drafting after this long is failed, and its
   * "Drafting…" message says so. Longer than an answer: a page is a longer
   * completion than a reply.
   */
  CHAT_CAPTURE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  /**
   * How often subscribed groups are checked for news (phase 3). Instant
   * delivery is "within one tick"; a digest is due on the first tick past its
   * window.
   */
  CHAT_DIGEST_TICK_MS: z.coerce.number().int().min(5_000).default(60_000),
  /**
   * The Bot API host. Overridable for a self-hosted Bot API server or a proxy,
   * which a deployment that cannot reach api.telegram.org directly needs.
   */
  TELEGRAM_API_BASE_URL: z.string().url().default('https://api.telegram.org'),
  /**
   * Allow a self-hosted messenger (Time) on a private/loopback address. An
   * in-house Time server is the usual deployment, but a URL typed into a
   * settings form is also the classic SSRF shape, so the default refuses it.
   * Mirrors CONNECTOR_ALLOW_PRIVATE_URLS.
   */
  CHAT_ALLOW_PRIVATE_URLS: boolish(false),
  /**
   * How often the API compares its open Time websockets with the enabled bots
   * (phase 4): a bot saved, switched off or given a new token is picked up
   * within one tick. Reconnects after a drop do not wait for it.
   */
  CHAT_SOCKET_SYNC_MS: z.coerce.number().int().min(1_000).default(15_000),

  /**
   * Interface + API language (docs/features/18). Also the fallback whenever a
   * request carries no ?lang=, no kn_lang cookie and no usable Accept-Language,
   * and the language worker-generated prose defaults to. Must keep a default:
   * scripts/generate-openapi.main.ts runs this validation with no infra.
   */
  I18N_DEFAULT_LOCALE: z.enum(['en', 'ru']).default('en'),
});

export type Env = z.infer<typeof envSchema>;

function smtpUrlHasUserinfo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

/** Fail-fast env validation, plugged into @nestjs/config `validate`. */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  // Opting into SMTP without a server would otherwise boot, then fail every send.
  if (parsed.data.MAIL_TRANSPORT === 'smtp' && !parsed.data.MAIL_SMTP_URL) {
    throw new Error('Invalid environment:\n  MAIL_SMTP_URL: required when MAIL_TRANSPORT=smtp');
  }
  // nodemailer would silently prefer the URL's userinfo — refuse rather than pick one.
  if (parsed.data.MAIL_SMTP_USER && smtpUrlHasUserinfo(parsed.data.MAIL_SMTP_URL)) {
    throw new Error('Invalid environment:\n  MAIL_SMTP_USER: set, but MAIL_SMTP_URL also carries credentials — keep one');
  }
  return parsed.data;
}
