import type { ApiDocumentKind } from '@knowledge/contracts/core';
import { normalizeEntityKey } from '@knowledge/contracts/graph';
import type { ApiSpecDiff } from '@knowledge/contracts/api/diff';
import type { CodeSample } from '@knowledge/contracts/api/samples';

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
export type ApiSpecKind = Exclude<ApiDocumentKind, 'page'>;

export function isApiSpecKind(kind: string | null | undefined): kind is ApiSpecKind {
  return kind === 'openapi' || kind === 'asyncapi';
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
