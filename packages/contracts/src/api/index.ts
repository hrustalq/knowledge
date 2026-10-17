import type { ApiDocumentKind } from '@knowledge/contracts/core';
import { normalizeEntityKey } from '@knowledge/contracts/graph';

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
