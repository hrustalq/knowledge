import { dereference, normalize, upgrade, validate } from '@scalar/openapi-parser';
import {
  channelEntityKey,
  operationEntityKey,
  type ApiOperationSummary,
  type ApiSpecKind,
} from '@knowledge/contracts';

/**
 * Parsing an API spec (#78): parse, validate, dereference internal `$ref`s and
 * up-convert, with no Nest and no I/O so the finalize check (API) and the
 * ingestion branch (worker) run exactly the same code.
 *
 * OpenAPI goes through `@scalar/openapi-parser`: it validates 2.0 / 3.0 / 3.1,
 * upgrades everything to 3.1, and resolves only internal references — it has no
 * fetch unless handed the `fetch-urls` plugin, which nothing here passes, so a
 * remote `$ref` is a validation error, never a request. AsyncAPI has no parser
 * that is ESM, small and offline (`@asyncapi/parser` pulls in spectral), so it
 * is read here: the same `normalize` + `dereference`, which are not
 * OpenAPI-specific, plus the few structural checks a reader needs.
 */

/** Validator messages a 422 carries, and the ingestion job's error. */
export interface ApiSpecIssue {
  message: string;
  /** JSON pointer, when the validator gave one. */
  path?: string;
}

export class ApiSpecError extends Error {
  constructor(readonly issues: ApiSpecIssue[]) {
    super(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ') || 'Invalid API spec');
  }
}

export interface ParsedApiSpec {
  kind: ApiSpecKind;
  /** The spec version as written: `3.0.3`, `2.0`, `2.6.0`… */
  specVersion: string;
  title: string;
  /** `info.version`. */
  version: string | null;
  description: string | null;
  /** `x-knowledge-key`, the only thing that re-pins a document's slug. */
  keyHint: string | null;
  /** Fully dereferenced; may be cyclic where the spec's schemas recurse. */
  document: Record<string, unknown>;
  operations: ParsedOperation[];
}

/** An operation before it has a slug, and so before it has an entity key. */
export interface ParsedOperation extends Omit<ApiOperationSummary, 'entityKey'> {
  /** The dereferenced operation object, for the projection. */
  raw: Record<string, unknown>;
  /** Path-level parameters (OpenAPI) or the channel object (AsyncAPI). */
  parent: Record<string, unknown>;
}

export interface ApiSpecLimits {
  maxBytes: number;
  maxOperations: number;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export async function parseApiSpec(raw: string, kind: ApiSpecKind, limits: ApiSpecLimits): Promise<ParsedApiSpec> {
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > limits.maxBytes) {
    throw new ApiSpecError([{ message: `The spec is ${bytes} bytes; the limit is ${limits.maxBytes}` }]);
  }
  let input: Record<string, unknown>;
  try {
    const value: unknown = normalize(raw);
    if (!isObject(value)) throw new Error('The document is not a YAML or JSON object');
    input = value;
  } catch (e) {
    throw new ApiSpecError([{ message: (e as Error).message.split('\n')[0] }]);
  }
  const parsed = kind === 'openapi' ? await parseOpenApi(input) : parseAsyncApi(input);
  if (parsed.operations.length > limits.maxOperations) {
    throw new ApiSpecError([
      { message: `The spec defines ${parsed.operations.length} operations; the limit is ${limits.maxOperations}` },
    ]);
  }
  return parsed;
}

/**
 * The operations with their entity keys under `slug`. A second operation that
 * folds to a key already taken (`/users/{id}` and `/users/{userId}`, both GET)
 * is the same operation by our rules, so the first one wins.
 */
export function keyOperations(parsed: ParsedApiSpec, slug: string): Array<ParsedOperation & { entityKey: string }> {
  const seen = new Set<string>();
  const out: Array<ParsedOperation & { entityKey: string }> = [];
  for (const op of parsed.operations) {
    const entityKey =
      op.protocol === 'http' ? operationEntityKey(slug, op.method ?? 'GET', op.path) : channelEntityKey(slug, op.path);
    const unique = `${entityKey} ${op.method ?? ''}`;
    if (seen.has(unique)) continue;
    seen.add(unique);
    out.push({ ...op, entityKey });
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

async function parseOpenApi(input: Record<string, unknown>): Promise<ParsedApiSpec> {
  const specVersion = str(input.openapi) ?? str(input.swagger);
  if (!specVersion) {
    throw new ApiSpecError([{ message: 'Not an OpenAPI document: no top-level `openapi` or `swagger` field' }]);
  }
  // Validated as written — a 2.0 document against the 2.0 schema — so the
  // messages point at what the author wrote, not at the upgraded copy.
  const checked = await validate(input);
  if (!checked.valid) throw new ApiSpecError(issuesOf(checked.errors));

  const { specification } = upgrade(input);
  if (!specification) throw new ApiSpecError([{ message: 'The document could not be upgraded to OpenAPI 3.1' }]);
  const resolved = dereference(specification);
  if (resolved.errors?.length) throw new ApiSpecError(issuesOf(resolved.errors));
  const document = (resolved.schema ?? specification) as Record<string, unknown>;

  const info = isObject(document.info) ? document.info : {};
  const operations: ParsedOperation[] = [];
  const paths = isObject(document.paths) ? document.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      operations.push({
        protocol: 'http',
        method: method.toUpperCase(),
        path,
        operationId: str(op.operationId),
        summary: str(op.summary) ?? firstLine(str(op.description)),
        tags: Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === 'string') : [],
        deprecated: op.deprecated === true,
        pointer: `/paths/${escapePointer(path)}/${method}`,
        raw: op,
        parent: item,
      });
    }
  }
  return {
    kind: 'openapi',
    specVersion,
    title: str(info.title) ?? 'API',
    version: str(info.version),
    description: str(info.description),
    keyHint: str(document['x-knowledge-key']) ?? str(input['x-knowledge-key']),
    document,
    operations,
  };
}

// ---------------------------------------------------------------------------
// AsyncAPI 2.x / 3.x
// ---------------------------------------------------------------------------

function parseAsyncApi(input: Record<string, unknown>): ParsedApiSpec {
  const specVersion = str(input.asyncapi);
  if (!specVersion) throw new ApiSpecError([{ message: 'Not an AsyncAPI document: no top-level `asyncapi` field' }]);
  const major = Number(specVersion.split('.')[0]);
  if (major !== 2 && major !== 3) {
    throw new ApiSpecError([{ message: `AsyncAPI ${specVersion} is not supported; use 2.x or 3.x`, path: '/asyncapi' }]);
  }
  const issues: ApiSpecIssue[] = [];
  if (!isObject(input.info)) issues.push({ message: 'must have required property info', path: '/info' });
  else if (!str(input.info.title)) issues.push({ message: 'must have required property title', path: '/info' });
  if (input.channels !== undefined && !isObject(input.channels)) {
    issues.push({ message: 'must be object', path: '/channels' });
  }
  if (major === 3 && input.operations !== undefined && !isObject(input.operations)) {
    issues.push({ message: 'must be object', path: '/operations' });
  }
  if (issues.length) throw new ApiSpecError(issues);

  const resolved = dereference(input);
  if (resolved.errors?.length) throw new ApiSpecError(issuesOf(resolved.errors));
  const document = (resolved.schema ?? input) as Record<string, unknown>;
  const info = document.info as Record<string, unknown>;
  const channels = isObject(document.channels) ? document.channels : {};

  const operations: ParsedOperation[] = [];
  if (major === 2) {
    // 2.x: the channel key is the address; `publish` / `subscribe` sit on it.
    for (const [address, channel] of Object.entries(channels)) {
      if (!isObject(channel)) continue;
      const actions = (['publish', 'subscribe'] as const).filter((a) => isObject(channel[a]));
      for (const action of actions) {
        const op = channel[action] as Record<string, unknown>;
        operations.push(asyncOperation(address, action, op, channel, `/channels/${escapePointer(address)}/${action}`));
      }
      if (actions.length === 0) operations.push(asyncOperation(address, null, channel, channel, `/channels/${escapePointer(address)}`));
    }
  } else {
    // 3.x: channels carry an `address`; operations name their channel by $ref,
    // which `dereference` has already replaced with the channel object itself.
    // A dereferenced channel is a copy, not the object under `channels`, so
    // "this channel has an operation" is matched by address.
    const used = new Set<string>();
    const ops = isObject(document.operations) ? document.operations : {};
    for (const [id, op] of Object.entries(ops)) {
      if (!isObject(op)) continue;
      const channel = isObject(op.channel) ? op.channel : {};
      const address = str(channel.address) ?? channelIdOf(channels, channel) ?? id;
      used.add(address);
      operations.push({
        ...asyncOperation(address, str(op.action), op, channel, `/operations/${escapePointer(id)}`),
        operationId: id,
      });
    }
    for (const [id, channel] of Object.entries(channels)) {
      if (!isObject(channel) || used.has(str(channel.address) ?? id)) continue;
      operations.push(asyncOperation(str(channel.address) ?? id, null, channel, channel, `/channels/${escapePointer(id)}`));
    }
  }
  return {
    kind: 'asyncapi',
    specVersion,
    title: str(info.title) ?? 'API',
    version: str(info.version),
    description: str(info.description),
    keyHint: str(document['x-knowledge-key']),
    document,
    operations,
  };
}

function asyncOperation(
  address: string,
  action: string | null,
  op: Record<string, unknown>,
  channel: Record<string, unknown>,
  pointer: string,
): ParsedOperation {
  const tags = Array.isArray(op.tags)
    ? op.tags.map((t) => (isObject(t) ? str(t.name) : str(t))).filter((t): t is string => !!t)
    : [];
  return {
    protocol: 'async',
    method: action,
    path: address,
    operationId: str(op.operationId),
    summary: str(op.summary) ?? firstLine(str(op.description)) ?? firstLine(str(channel.description)),
    tags,
    deprecated: op.deprecated === true,
    pointer,
    raw: op,
    parent: channel,
  };
}

function channelIdOf(channels: Record<string, unknown>, channel: unknown): string | null {
  for (const [id, c] of Object.entries(channels)) if (c === channel) return id;
  return null;
}

// ---------------------------------------------------------------------------

function issuesOf(errors: Array<{ message?: string; path?: string | string[] }> | undefined): ApiSpecIssue[] {
  const out = (errors ?? []).slice(0, 50).map((e) => {
    const path = Array.isArray(e.path) ? e.path.map((p) => `/${escapePointer(String(p))}`).join('') : e.path;
    return { message: e.message ?? 'Invalid', ...(path ? { path } : {}) };
  });
  return out.length ? out : [{ message: 'Invalid API spec' }];
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.trim() ? v : null;
}

function firstLine(v: string | null): string | null {
  const line = v?.trim().split('\n')[0]?.trim();
  return line ? line.slice(0, 200) : null;
}

/** RFC 6901: `~` → `~0`, `/` → `~1`. */
function escapePointer(segment: string): string {
  return segment.replace(/~/gu, '~0').replace(/\//gu, '~1');
}
