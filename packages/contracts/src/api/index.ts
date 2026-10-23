import type { ApiDocumentKind } from '@knowledge/contracts/core';
import { normalizeEntityKey } from '@knowledge/contracts/graph';
import type { ApiSpecDiff, ApiSpecDiffSummary } from '@knowledge/contracts/api/diff';
import type { CodeSample } from '@knowledge/contracts/api/samples';
import type { ApiTestCase, SuitePrerequisite, SuitePrerequisiteSource } from '@knowledge/contracts/api/test-cases';

// ---------------------------------------------------------------------------
// API reference documents (#78).
//
// A spec is a normal document with normal revisions — branches, merge
// requests, history and ACLs come for free — whose `kind` says its body is an
// OpenAPI or AsyncAPI description instead of markdown. These live in contracts
// because the ingestion worker, the frontmatter parser, the editor's operation
// picker and the drift check all derive the same entity key from an operation,
// and four spellings of one key are four vertices for one endpoint.
// ---------------------------------------------------------------------------


/** The kinds whose body is a spec rather than markdown. */
export type ApiSpecKind = Exclude<ApiDocumentKind, 'page' | 'test-fixture'>;

export function isApiSpecKind(kind: string | null | undefined): kind is ApiSpecKind {
  return kind === 'openapi' || kind === 'asyncapi';
}

/** A QA test fixture (#483): setup and teardown calls, not a spec. */
export function isTestFixtureKind(kind: string | null | undefined): kind is 'test-fixture' {
  return kind === 'test-fixture';
}

/**
 * The kinds whose body is YAML or JSON stored verbatim — a spec or a fixture.
 * They have no frontmatter, cannot start from a template, and are stored under
 * a `vnd` type in the syntax the author named (`structuredContentType`).
 */
export function isStructuredKind(kind: string | null | undefined): kind is ApiSpecKind | 'test-fixture' {
  return isApiSpecKind(kind) || isTestFixtureKind(kind);
}

/** How a spec body is written. YAML is a superset of JSON, so either parses as YAML. */
export const API_SPEC_SYNTAXES = ['yaml', 'json'] as const;
export type ApiSpecSyntax = (typeof API_SPEC_SYNTAXES)[number];

/**
 * The content type a spec revision is stored under: the registered OpenAPI
 * (`vnd.oai`) and AsyncAPI (`vnd.aai`) media types. The kind decides how a
 * revision is parsed; this only names the object and tells a downloader what
 * it got.
 */
export function apiSpecContentType(kind: ApiSpecKind, syntax: ApiSpecSyntax): string {
  return `application/vnd.${kind === 'openapi' ? 'oai.openapi' : 'aai.asyncapi'}+${syntax}`;
}

/** `apiSpecContentType`, plus the fixture's own `vnd.knowledge.test-fixture` type. */
export function structuredContentType(kind: ApiSpecKind | 'test-fixture', syntax: ApiSpecSyntax): string {
  return kind === 'test-fixture' ? `application/vnd.knowledge.test-fixture+${syntax}` : apiSpecContentType(kind, syntax);
}

/**
 * Content types accepted for a spec upload, besides the two `vnd` types per
 * kind: what a browser or `curl` sends for a `.yaml` / `.json` file.
 */
export const API_SPEC_CONTENT_TYPES = [
  'application/vnd.oai.openapi+yaml',
  'application/vnd.oai.openapi+json',
  'application/vnd.aai.asyncapi+yaml',
  'application/vnd.aai.asyncapi+json',
  'application/yaml',
  'application/x-yaml',
  'text/yaml',
  'text/x-yaml',
  'application/json',
] as const;

/** `source.yaml` / `source.json` for a spec, `source.md` for everything else. */
export function apiSpecSyntaxOf(contentType: string): ApiSpecSyntax | null {
  const t = contentType.toLowerCase();
  if (t.includes('json')) return 'json';
  if (t.includes('yaml') || t.includes('yml')) return 'yaml';
  return null;
}

// ---------------------------------------------------------------------------
// Operation identity
// ---------------------------------------------------------------------------

/**
 * One path, however it is spelled in the spec: a leading slash, no trailing
 * one, no doubled ones, and every `{param}` folded to `{}`. The fold is what
 * makes `/users/{id}` and `/users/{userId}` one operation — renaming a path
 * parameter changes no request a client sends.
 *
 * Case is left alone here; `normalizeEntityKey` folds it in the key.
 */
export function normalizeApiPath(path: string): string {
  let p = path.trim().replace(/\{[^}]*\}/gu, '{}').replace(/\/{2,}/gu, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * The slug a spec's operations are keyed under, from `x-knowledge-key` or
 * `info.title`. Never contains a colon: the key's structure is
 * `op:<slug>:<METHOD> <path>`, and `normalizeEntityKey` splits on colons.
 *
 * Callers pin the result on the document at its first indexed revision, so a
 * later title edit does not fork every operation entity (#78).
 */
export function apiSpecSlug(raw: string | null | undefined): string {
  const slug = (raw ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug || 'api';
}

/** `op:billing-api:post-/invoices` — HTTP operations, keyed by method and path. */
export function operationEntityKey(slug: string, method: string, path: string): string {
  return normalizeEntityKey(`op:${apiSpecSlug(slug)}:${method.toUpperCase()} ${normalizeApiPath(path)}`);
}

/** `channel:events:user/{}/signedup` — AsyncAPI channels, keyed by address. */
export function channelEntityKey(slug: string, address: string): string {
  return normalizeEntityKey(`channel:${apiSpecSlug(slug)}:${address.trim()}`);
}

// ---------------------------------------------------------------------------
// The parsed shape the ingestion worker projects and stores per revision.
// ---------------------------------------------------------------------------

export type ApiOperationProtocol = 'http' | 'async';

export interface ApiOperationSummary {
  protocol: ApiOperationProtocol;
  /** `GET`… for HTTP; `send` / `receive` (or 2.x `publish` / `subscribe`) for AsyncAPI. */
  method: string | null;
  /** `/users/{id}` as the spec spells it, or a channel address. */
  path: string;
  operationId: string | null;
  entityKey: string;
  summary: string | null;
  tags: string[];
  deprecated: boolean;
  /** JSON pointer into the spec (`/paths/~1users~1{id}/get`), for deep links. */
  pointer: string;
}

// ---------------------------------------------------------------------------
// Read API (#78, phase 2)
// ---------------------------------------------------------------------------

/** One stored operation, as the reference sidebar and the picker read it. */
export interface ApiOperationInfo extends ApiOperationSummary {
  documentId: string;
  revisionId: string;
}

/** GET /v1/api-specs — a spec document and how many operations its head defines. */
export interface ApiSpecSummary {
  documentId: string;
  projectId: string;
  title: string;
  kind: ApiSpecKind;
  /** The pinned operation-key slug; null until the spec first indexes. */
  slug: string | null;
  headRevisionId: string | null;
  /** `indexed` once the head's operations are readable. */
  headRevisionStatus: string | null;
  /** Operations of the head revision; 0 while it is still indexing. */
  operationCount: number;
  createdAt: string;
}

export interface ListApiSpecsResponse {
  specs: ApiSpecSummary[];
}

/**
 * GET /v1/api-specs/:documentId — the spec of one revision, parsed. OpenAPI is
 * upgraded to 3.1; internal `$ref`s are kept rather than inlined, because a
 * recursive schema dereferences to a cyclic object no JSON can carry. The
 * renderer resolves them against `document`.
 */
export interface ApiSpecDocumentResponse {
  documentId: string;
  revisionId: string;
  kind: ApiSpecKind;
  /** As written: `3.0.3`, `2.0`, `2.6.0`… */
  specVersion: string;
  title: string;
  version: string | null;
  slug: string | null;
  document: Record<string, unknown>;
}

/** GET /v1/api-specs/:documentId/operations */
export interface ListApiOperationsResponse {
  documentId: string;
  /** The revision listed: the default-branch head unless one was asked for. */
  revisionId: string | null;
  revisionStatus: string | null;
  operations: ApiOperationInfo[];
}

/** GET /v1/api-operations — the picker: operations across every spec the caller may open. */
export interface SearchApiOperationsResponse {
  operations: Array<ApiOperationInfo & { specTitle: string }>;
}

// ---------------------------------------------------------------------------
// Code samples and try-it (#78, phase 4)
// ---------------------------------------------------------------------------

/** GET /v1/api-specs/:documentId/samples — one operation's samples. */
export interface ApiOperationSamplesResponse {
  documentId: string;
  revisionId: string;
  entityKey: string;
  samples: CodeSample[];
}

// ---------------------------------------------------------------------------
// QA test suites (#468)
// ---------------------------------------------------------------------------

/** How a suite is exported: one curl command per case, or a Postman Collection v2.1. */
export const API_TEST_SUITE_FORMATS = ['curl', 'postman'] as const;
export type ApiTestSuiteFormat = (typeof API_TEST_SUITE_FORMATS)[number];

/** GET /v1/api-specs/:documentId/test-suite — one operation's cached suite. */
export interface ApiTestSuiteResponse {
  documentId: string;
  entityKey: string;
  /** The spec revision the suite was generated from; a later one that left the operation alone shares it. */
  revisionId: string;
  generatedAt: string;
  generatedBy: string;
  catalogueVersion: number;
  cases: ApiTestCase[];
}

/** POST /v1/api-specs/:documentId/test-suite — the cached suite, or the `tester` run filling it. */
export interface GenerateApiTestSuiteResponse {
  suite: ApiTestSuiteResponse | null;
  runId: string | null;
  /** True when a run for the same operation and config was already in flight, and that run is returned. */
  existing: boolean;
}

/** One fixture bound to a suite (#483). */
export interface ApiTestBindingInfo {
  fixtureId: string;
  /** Null when the caller cannot open the fixture: a binding never leaks a title. */
  title: string | null;
  headRevisionId: string | null;
  /** The fixture was archived after it was bound; it still runs until unbound. */
  archived: boolean;
}

/** GET /v1/api-specs/:documentId/test-bindings — the fixtures that set up one operation's suite. */
export interface ApiTestBindingsResponse {
  documentId: string;
  entityKey: string;
  /** Run once, before every case. */
  suite: ApiTestBindingInfo[];
  /** Case id → fixtures run just before that case; their captures shadow the suite's for it. */
  cases: Record<string, ApiTestBindingInfo[]>;
}

/** One operation of the same spec that produces a value the suite needs, with the fixtures already calling it. */
export interface ApiTestPrerequisite extends SuitePrerequisite {
  operation: { method: string | null; path: string; summary: string | null } | null;
}

/** A fixture offered as setup: it calls a producer of a value the operation needs. */
export interface ApiTestFixtureCandidate {
  documentId: string;
  title: string;
  headRevisionId: string | null;
  /** The strongest evidence among the producers it calls. */
  source: SuitePrerequisiteSource;
  /** The producer keys it calls. */
  producers: string[];
  /** Why it is offered, from the spec. */
  reason: string;
  /** The tester's words, once a ranking run for this exact candidate set succeeded. */
  explanation: string | null;
  /** Already bound to the whole suite. */
  bound: boolean;
}

/** Where the tester's ranking of this candidate set stands. */
export type ApiTestRankingStatus = 'none' | 'pending' | 'ready' | 'failed';

/** GET /v1/api-specs/:documentId/test-fixture-candidates */
export interface ApiTestFixtureCandidatesResponse {
  documentId: string;
  entityKey: string;
  prerequisites: ApiTestPrerequisite[];
  /** Spec order (links, then path parameters), or the tester's when `ranking.status` is `ready`. Nothing here is bound. */
  candidates: ApiTestFixtureCandidate[];
  ranking: { status: ApiTestRankingStatus; runId: string | null };
}

/** POST /v1/api-specs/:documentId/test-fixture-candidates/rank — the tester run ranking the current candidate set. */
export interface RankApiTestFixturesResponse {
  runId: string | null;
  /** True when a run for the same candidate set was already in flight (or done), and that run is returned. */
  existing: boolean;
}

// ---------------------------------------------------------------------------
// QA overview (#483, phase 4)
// ---------------------------------------------------------------------------

/** One operation's QA state, worst first — the order /qa sorts by. */
export const QA_SUITE_STATUSES = ['review', 'unbound', 'outdated', 'none', 'ready'] as const;
export type QaSuiteStatus = (typeof QA_SUITE_STATUSES)[number];

/** Whether a suite is stored for the operation, and whether it matches the cache key as things stand now. */
export type QaSuiteState = 'none' | 'outdated' | 'current';

/**
 * Derived on read, never stored. A bound fixture needing review outranks the
 * rest — regenerating does not fix it. Without a current suite, Generate is
 * the next step whatever the setup; with one, prerequisites the spec names
 * but no suite-level fixture covers are what is missing.
 */
export function qaSuiteStatusFor(s: { suite: QaSuiteState; prerequisites: number; suiteBindings: number; reviewFixtures: number }): QaSuiteStatus {
  if (s.reviewFixtures > 0) return 'review';
  if (s.suite === 'none') return 'none';
  if (s.suite === 'outdated') return 'outdated';
  return s.prerequisites > 0 && s.suiteBindings === 0 ? 'unbound' : 'ready';
}

/** One HTTP operation at its spec's head, as /qa lists it. */
export interface QaOperationRow {
  documentId: string;
  specTitle: string;
  entityKey: string;
  method: string | null;
  path: string;
  summary: string | null;
  deprecated: boolean;
  status: QaSuiteStatus;
  suite: { state: QaSuiteState; cases: number | null };
  /** Operations of the same spec producing a value this one needs (`suitePrerequisites`). */
  prerequisites: number;
  /** Fixtures bound to the whole suite, and to single cases. */
  bound: { suite: number; cases: number };
  /** Bound fixtures that are archived or call an operation no spec head defines. Counted even when the reader cannot open them. */
  reviewFixtures: number;
  /** Fixtures the reader may open whose head calls this operation. */
  fixtures: number;
}

/** GET /v1/qa/overview — every HTTP operation of the OpenAPI specs in scope, worst first. */
export interface QaOverviewResponse {
  operations: QaOperationRow[];
  /** OpenAPI specs read; 0 means there is nothing to test yet. */
  specs: number;
}

/**
 * How far the try-it proxy reaches. `allowlist` reuses the workspace's source
 * policies (docs/features/25), so there is one host list, not two.
 */
export const API_TRY_PROXY_MODES = ['off', 'allowlist', 'open'] as const;
export type ApiTryProxyMode = (typeof API_TRY_PROXY_MODES)[number];

/** What the workspace asked for beside what applies, so a clamp is never silent. */
export interface ApiTryProxySettings {
  /** The workspace override; null inherits the ceiling. */
  requested: ApiTryProxyMode | null;
  /** API_TRY_PROXY_MODE. */
  ceiling: ApiTryProxyMode;
  effective: ApiTryProxyMode;
  /** `clamped` when `requested` is wider than the ceiling. */
  source: 'env' | 'db' | 'clamped';
}

/** GET/PATCH /v1/workspaces/:id/api-settings */
export interface ApiSettingsResponse {
  workspaceId: string;
  tryProxy: ApiTryProxySettings;
  /** The merge gate for breaking spec changes (phase 6): the override beside what applies. */
  breakingChanges: { requested: ApiBreakingChangePolicy | null; effective: ApiBreakingChangePolicy };
  /** The proxy's deployment caps, for the console to state. */
  tryLimits: { timeoutMs: number; maxRequestBytes: number; maxResponseBytes: number; perMinute: number };
  updatedAt: string | null;
}

export interface UpdateApiSettingsRequest {
  /** null goes back to the ceiling. */
  apiTryProxyMode?: ApiTryProxyMode | null;
  /** null goes back to the default, `warn`. */
  apiBreakingChangePolicy?: ApiBreakingChangePolicy | null;
}

/** The largest request body the proxy forwards. */
export const API_TRY_MAX_REQUEST_BYTES = 256 * 1024;

export interface ApiTryHeader {
  name: string;
  value: string;
}

/**
 * POST /v1/api-specs/:documentId/try. The target must be a server of
 * `revisionId` and the path one of `entityKey`'s. Credentials ride in
 * `headers`, per request, and are neither stored nor logged.
 */
export interface ApiTryRequest {
  revisionId: string;
  entityKey: string;
  method: string;
  url: string;
  headers?: ApiTryHeader[];
  body?: string | null;
}

export interface ApiTryResponse {
  status: number;
  statusText: string;
  /** Filtered: no `Set-Cookie`, no hop-by-hop headers. */
  headers: ApiTryHeader[];
  /** UTF-8 text, or base64 for a body that is not text. */
  body: string;
  encoding: 'utf8' | 'base64';
  /** Bytes received, up to the cap. */
  bytes: number;
  /** True when the body was cut at API_TRY_MAX_RESPONSE_BYTES. */
  truncated: boolean;
  durationMs: number;
  /** Request headers the proxy would not forward (`Cookie`, `Host`, hop-by-hop), so dropping one is never silent. */
  droppedHeaders: string[];
}

// ---------------------------------------------------------------------------
// Spec diff and breaking changes (#78, phase 6)
// ---------------------------------------------------------------------------

/**
 * What a merge request that introduces a breaking change does (#78): `off`
 * neither warns nor gates (the diff is still readable), `warn` names the
 * changes in the merge widget and merges, `block` refuses the merge until an
 * admin acknowledges the source head.
 */
export const API_BREAKING_CHANGE_POLICIES = ['off', 'warn', 'block'] as const;
export type ApiBreakingChangePolicy = (typeof API_BREAKING_CHANGE_POLICIES)[number];
export const DEFAULT_API_BREAKING_CHANGE_POLICY: ApiBreakingChangePolicy = 'warn';

/** A sparse setting over the code default; there is no env ceiling for this one. */
export function resolveApiBreakingChangePolicy(requested: string | null | undefined): ApiBreakingChangePolicy {
  return API_BREAKING_CHANGE_POLICIES.includes(requested as ApiBreakingChangePolicy)
    ? (requested as ApiBreakingChangePolicy)
    : DEFAULT_API_BREAKING_CHANGE_POLICY;
}

/** An admin's acknowledgement of the breaking changes at one source head. */
export interface ApiBreakingAck {
  by: string;
  at: string;
  /** The source head acknowledged; a later push needs a new acknowledgement. */
  revisionId: string;
  /** True while `revisionId` is still the source head. */
  current: boolean;
}

/** A page that links an operation a change touches. */
export interface ApiAffectedPage {
  documentId: string;
  title: string;
  relationType: string;
  extractor: string;
}

/** GET /v1/merge-requests/:id/api-changes */
export interface MergeRequestApiChangesResponse {
  mergeRequestId: string;
  documentId: string;
  /** False for a page document: nothing below applies. */
  applicable: boolean;
  policy: ApiBreakingChangePolicy;
  /** The merge base (or nothing, for a first merge) against the source head. Null when not applicable. */
  diff: ApiSpecDiff | null;
  /** Pages linking each changed operation, keyed by entity key; the spec itself is left out. */
  affectedPages: Record<string, ApiAffectedPage[]>;
  ack: ApiBreakingAck | null;
  /** True when merging now would be refused with `breaking-api`. */
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// Spec ↔ code drift (#78, phase 8)
// ---------------------------------------------------------------------------

/**
 * How a spec and the routes its repository declares disagree. Closed: the
 * comparator emits exactly these, the PR comment and the web label them, and
 * a value the comparator never emits would be a label for nothing.
 */
export const API_DRIFT_KINDS = ['missing-in-code', 'missing-in-spec', 'method-mismatch'] as const;
export type ApiDriftKind = (typeof API_DRIFT_KINDS)[number];

/** One path the spec and the code disagree about. */
export interface ApiDriftMismatch {
  kind: ApiDriftKind;
  /** As the spec spells it; as the code does for `missing-in-spec`. */
  path: string;
  /** The methods this is about: the spec's with no route, or the code's with no operation. `*` is any method. */
  methods: string[];
  /** `method-mismatch` only: the methods the code declares for the path instead. */
  codeMethods?: string[];
  /** Where the code declares the route, when it does. */
  file?: string;
  line?: number;
}

/** What one spec document was compared against, and what disagreed. */
export interface ApiDriftSpec {
  documentId: string;
  title: string;
  /** The spec file in the repository. */
  specPath: string;
  /** Routes read from the code. 0 means no supported framework was found, and nothing was compared. */
  routes: number;
  frameworks: string[];
  /** Route declarations whose path was not a literal, so were not read. */
  dynamic: number;
  /** Capped; `mismatchTotal` is the whole count. On a pull request, only what the change introduces. */
  mismatches: ApiDriftMismatch[];
  mismatchTotal: number;
  /** A pull request that changed the spec file: the classified diff, base → head. */
  changes?: ApiSpecDiffSummary;
}

/** POST /v1/api-specs/:documentId/drift-check */
export interface ApiDriftCheckResponse {
  runId: string;
  /** True when a check of this spec was already waiting or running, and that run is returned. */
  existing: boolean;
}
