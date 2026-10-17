import { isObject, type ParsedApiSpec, type ParsedOperation } from './api-spec.parser.js';

/**
 * A spec as markdown (#78): what search, the assistant and BM25 read.
 *
 * The ingestion pipeline after this point is the markdown one, unchanged —
 * `splitMarkdown → chunkSections → embed → upsertRevisionChunks → fulltext` —
 * so a spec is searchable with no new retrieval code. One `##` per tag and one
 * `###` per operation keeps every chunk inside a single operation, with the
 * heading breadcrumb (`Users > GET /users/{id}`) naming it.
 *
 * The text is the spec author's, so it is never trusted: it is indexed as
 * content and reaches a model only wrapped, like any page body.
 */

/** Deep enough to name a nested field, shallow enough that a wide schema stays one chunk. */
const SCHEMA_DEPTH = 3;
const SCHEMA_FIELDS = 60;

export function renderSpecProjection(spec: ParsedApiSpec, operations: ParsedOperation[] = spec.operations): string {
  const out: string[] = [];
  out.push(`# ${inline(spec.title)}${spec.version ? ` ${inline(spec.version)}` : ''}`, '');
  out.push(`${spec.kind === 'openapi' ? 'OpenAPI' : 'AsyncAPI'} ${inline(spec.specVersion)}`, '');
  if (spec.description) out.push(block(spec.description), '');
  const servers = serversOf(spec);
  if (servers.length) {
    out.push('**Servers**', '', ...servers.map((s) => `- \`${inline(s)}\``), '');
  }

  // Grouped by first tag, in the order tags first appear; untagged last.
  const groups = new Map<string, ParsedOperation[]>();
  for (const op of operations) {
    const tag = op.tags[0] ?? '';
    groups.set(tag, [...(groups.get(tag) ?? []), op]);
  }
  const order = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : 0));
  const tagDocs = tagDescriptions(spec);
  for (const tag of order) {
    out.push(`## ${tag ? inline(tag) : spec.kind === 'openapi' ? 'Operations' : 'Channels'}`, '');
    if (tag && tagDocs.get(tag)) out.push(block(tagDocs.get(tag)!), '');
    for (const op of groups.get(tag)!) {
      out.push(...(op.protocol === 'http' ? httpOperation(op) : asyncOperation(op)), '');
    }
  }
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').trim() + '\n';
}

function httpOperation(op: ParsedOperation): string[] {
  const o = op.raw;
  const out = [`### ${op.method} ${inline(op.path)}`, ''];
  if (op.summary) out.push(inline(op.summary), '');
  const description = str(o.description);
  if (description && description.trim() !== op.summary) out.push(block(description), '');
  const meta = [op.operationId ? `Operation ID: \`${inline(op.operationId)}\`` : '', op.deprecated ? '**Deprecated**' : '']
    .filter(Boolean)
    .join(' · ');
  if (meta) out.push(meta, '');

  const params = [...asArray(op.parent.parameters), ...asArray(o.parameters)].filter(isObject);
  if (params.length) {
    out.push('#### Parameters', '', '| Name | In | Type | Required | Description |', '| --- | --- | --- | --- | --- |');
    for (const p of params) {
      out.push(
        `| ${cell(str(p.name))} | ${cell(str(p.in))} | ${cell(typeOf(p.schema))} | ${p.required === true ? 'yes' : 'no'} | ${cell(str(p.description))} |`,
      );
    }
    out.push('');
  }

  if (isObject(o.requestBody)) {
    const body = o.requestBody;
    out.push(`#### Request body${body.required === true ? ' (required)' : ''}`, '');
    if (str(body.description)) out.push(block(str(body.description)!), '');
    out.push(...contentOf(body.content));
  }

  if (isObject(o.responses)) {
    out.push('#### Responses', '', '| Status | Description |', '| --- | --- |');
    for (const [status, r] of Object.entries(o.responses)) {
      out.push(`| ${cell(status)} | ${cell(isObject(r) ? str(r.description) : null)} |`);
    }
    out.push('');
    for (const [status, r] of Object.entries(o.responses)) {
      if (!isObject(r) || !isObject(r.content)) continue;
      out.push(`##### ${inline(status)} response`, '', ...contentOf(r.content));
    }
  }
  return out;
}

function asyncOperation(op: ParsedOperation): string[] {
  const o = op.raw;
  const out = [`### ${op.method ? `${op.method} ` : ''}${inline(op.path)}`, ''];
  if (op.summary) out.push(inline(op.summary), '');
  const description = str(o.description) ?? (o === op.parent ? null : str(op.parent.description));
  if (description && description.trim() !== op.summary) out.push(block(description), '');
  const meta = [op.operationId ? `Operation ID: \`${inline(op.operationId)}\`` : '', op.deprecated ? '**Deprecated**' : '']
    .filter(Boolean)
    .join(' · ');
  if (meta) out.push(meta, '');
  // 2.x: `message` (one, or `oneOf`); 3.x: `messages` on the operation or its channel.
  const messages = [
    ...messagesOf(o.message),
    ...Object.values(isObject(o.messages) ? o.messages : isObject(op.parent.messages) ? op.parent.messages : {}),
  ].filter(isObject);
  for (const m of messages) {
    out.push(`#### Message ${inline(str(m.name) ?? str(m.title) ?? '')}`.trimEnd(), '');
    if (str(m.summary)) out.push(inline(str(m.summary)!), '');
    if (m.payload !== undefined) out.push('```', ...schemaLines(m.payload, 0, new Set(), { n: 0 }), '```', '');
  }
  return out;
}

function messagesOf(m: unknown): unknown[] {
  if (!isObject(m)) return [];
  return Array.isArray(m.oneOf) ? m.oneOf : [m];
}

function contentOf(content: unknown): string[] {
  if (!isObject(content)) return [];
  const out: string[] = [];
  for (const [type, media] of Object.entries(content)) {
    out.push(`\`${inline(type)}\``, '');
    if (isObject(media) && media.schema !== undefined) {
      out.push('```', ...schemaLines(media.schema, 0, new Set(), { n: 0 }), '```', '');
    }
  }
  return out;
}

/**
 * A schema as an indented field list. Cycle-safe: `dereference` turns a
 * recursive `$ref` into a cyclic object graph, so the walk tracks the objects
 * on its own path and stops at a repeat, as well as at the depth and field caps.
 */
function schemaLines(schema: unknown, depth: number, onPath: Set<unknown>, budget: { n: number }): string[] {
  if (!isObject(schema)) return [];
  if (onPath.has(schema)) return [`${pad(depth)}… (recursive)`];
  if (depth === 0 && !isObject(schema.properties) && !isObject(schema.items)) return [typeOf(schema)];
  onPath.add(schema);
  const out: string[] = [];
  const props = isObject(schema.properties)
    ? schema.properties
    : isObject(schema.items) && isObject(schema.items.properties)
      ? schema.items.properties
      : null;
  if (depth === 0 && schema.type === 'array') out.push('array of:');
  const required = new Set(asArray(isObject(schema.items) && !schema.properties ? schema.items.required : schema.required));
  for (const [name, child] of Object.entries(props ?? {})) {
    if (budget.n++ >= SCHEMA_FIELDS) {
      out.push(`${pad(depth)}…`);
      break;
    }
    const doc = isObject(child) ? str(child.description) : null;
    out.push(`${pad(depth)}${name}${required.has(name) ? '*' : ''}: ${typeOf(child)}${doc ? ` — ${firstLine(doc)}` : ''}`);
    if (depth + 1 < SCHEMA_DEPTH) out.push(...schemaLines(child, depth + 1, onPath, budget));
  }
  onPath.delete(schema);
  return out;
}

function typeOf(schema: unknown): string {
  if (!isObject(schema)) return '';
  for (const k of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(schema[k])) return `${k}(${schema[k].map(typeOf).filter(Boolean).join(', ')})`;
  }
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : str(schema.type);
  if (type === 'array') return `array<${typeOf(schema.items) || 'any'}>`;
  const format = str(schema.format);
  const enums = Array.isArray(schema.enum) ? ` (${schema.enum.slice(0, 10).map(String).join(', ')})` : '';
  return `${type ?? (isObject(schema.properties) ? 'object' : 'any')}${format ? `<${format}>` : ''}${enums}`;
}

function serversOf(spec: ParsedApiSpec): string[] {
  const s = spec.document.servers;
  if (Array.isArray(s)) return s.filter(isObject).map((x) => str(x.url)).filter((u): u is string => !!u);
  // AsyncAPI: a map of named servers (`host` in 3.x, `url` in 2.x).
  if (isObject(s)) {
    return Object.values(s)
      .filter(isObject)
      .map((x) => str(x.url) ?? [str(x.protocol), str(x.host)].filter(Boolean).join('://'))
      .filter(Boolean);
  }
  return [];
}

function tagDescriptions(spec: ParsedApiSpec): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of asArray(spec.document.tags)) {
    if (isObject(t) && str(t.name) && str(t.description)) map.set(str(t.name)!, str(t.description)!);
  }
  return map;
}

// ---------------------------------------------------------------------------

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.trim() ? v : null;
}

function firstLine(v: string): string {
  return v.trim().split('\n')[0].trim().slice(0, 200);
}

function pad(depth: number): string {
  return '  '.repeat(depth);
}

/** One line, for headings and inline spans. */
function inline(v: string): string {
  return v.replace(/\s+/gu, ' ').trim();
}

/** A table cell: one line, pipes escaped. */
function cell(v: string | null): string {
  return v ? inline(v).replace(/\|/gu, '\\|') : '';
}

/**
 * A description block. Its headings are demoted below `####` so a spec's own
 * markdown cannot open a section that splits an operation in two.
 */
function block(v: string): string {
  return v.trim().replace(/^#{1,6}(\s)/gmu, '#####$1');
}
