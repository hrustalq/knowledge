// ---------------------------------------------------------------------------
// Code samples and try-it requests for API spec operations (#78, phase 4).
//
// One request model, read out of the spec, and one printer per language. Here
// rather than in the web because the samples route and the MCP operation tool
// print the same samples the reference view shows, and three printers of one
// request would drift. Pure and dependency-free: no HTTPSnippet.
//
// Secrets are never values here. An auth header is a placeholder that names an
// environment variable (`$TOKEN`), and each printer reads it the way its
// language does (`process.env.TOKEN`, `os.environ['TOKEN']`). What a person
// types into the try-it console's credential fields never reaches a sample.
// ---------------------------------------------------------------------------

/** The sample languages: the reference tabs, the generator registry and the MCP tool all read this list. */
export const CODE_SAMPLE_LANGS = ['curl', 'javascript', 'python', 'go'] as const;
export type CodeSampleLang = (typeof CODE_SAMPLE_LANGS)[number];

export function isCodeSampleLang(v: unknown): v is CodeSampleLang {
  return typeof v === 'string' && (CODE_SAMPLE_LANGS as readonly string[]).includes(v);
}

/** A string that may read environment variables: literal runs and `{ env }` parts. */
export type SampleText = Array<string | { env: string }>;

export interface SampleRequest {
  method: string;
  /** Server + path with path parameters filled in, without the query. */
  url: string;
  query: Array<{ name: string; value: SampleText }>;
  headers: Array<{ name: string; value: SampleText }>;
  body: { contentType: string; text: string; json?: unknown } | null;
}

/** What the try-it console has filled in. Credentials are deliberately not a field. */
export interface SampleInputs {
  serverUrl?: string | null;
  path?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** The request body as typed; parsed as JSON when the content type is JSON. */
  body?: string | null;
  contentType?: string | null;
}

export interface CodeSample {
  lang: CodeSampleLang;
  source: string;
  /** `spec` when the author's `x-codeSamples` supplied it. */
  origin: 'spec' | 'generated';
  label: string | null;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | null {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return typeof v === 'string' && v.trim() ? v : null;
}

// ---------------------------------------------------------------------------
// Reading the spec
// ---------------------------------------------------------------------------

/** RFC 6901 lookup; null when a segment is missing. */
export function resolveSpecPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '#') return doc;
  let node: unknown = doc;
  for (const raw of pointer.replace(/^#/u, '').split('/').slice(1)) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isObj(node)) node = node[key];
    else return null;
    if (node === undefined) return null;
  }
  return node;
}

/**
 * Follow `$ref`s until a node that is not one. `ref` is the last pointer
 * followed; `cycle` is true when the chain met a ref it is already inside.
 * Only `#/…` pointers resolve: finalize refused anything else.
 */
export function derefSpec(
  doc: unknown,
  node: unknown,
  chain: readonly string[] = [],
): { node: unknown; ref: string | null; cycle: boolean } {
  let ref: string | null = null;
  let current = node;
  const seen = new Set(chain);
  while (isObj(current) && typeof current.$ref === 'string') {
    ref = current.$ref;
    if (seen.has(ref)) return { node: null, ref, cycle: true };
    seen.add(ref);
    current = ref.startsWith('#') ? resolveSpecPointer(doc, ref) : null;
  }
  return { node: current, ref, cycle: false };
}

const MAX_SERVER_EXPANSIONS = 32;

export interface ApiServerOption {
  /** The URL with every variable substituted. */
  url: string;
  /** As the spec writes it, `{region}` and all. */
  template: string;
  description: string | null;
}

/**
 * Every concrete URL the spec's OpenAPI `servers` allow: each variable takes
 * its `enum` values, or only its `default` when it has no enum. A free-form
 * variable is not a wildcard — the try-it proxy only reaches what this
 * returns, so a `{host}` variable must not mean "any host". Capped, so a spec
 * with many enum variables cannot fan out without end.
 */
export function apiServerOptions(doc: unknown): ApiServerOption[] {
  const servers = isObj(doc) && Array.isArray(doc.servers) ? doc.servers.filter(isObj) : [];
  const out: ApiServerOption[] = [];
  for (const server of servers) {
    const template = text(server.url);
    if (!template) continue;
    let urls = [template];
    const vars = isObj(server.variables) ? server.variables : {};
    for (const [name, def] of Object.entries(vars)) {
      if (!isObj(def)) continue;
      const values = Array.isArray(def.enum) && def.enum.length > 0 ? def.enum.map(String) : [text(def.default) ?? ''];
      urls = urls.flatMap((u) => values.map((v) => u.split(`{${name}}`).join(v)));
      if (urls.length > MAX_SERVER_EXPANSIONS) urls = urls.slice(0, MAX_SERVER_EXPANSIONS);
    }
    for (const url of urls) {
      if (!out.some((o) => o.url === url)) out.push({ url, template, description: text(server.description) });
    }
  }
  return out;
}

/** An example value for a schema: `example`, `default`, the first `enum`, else one built from its type. */
export function exampleForSchema(doc: unknown, schema: unknown, depth = 0, chain: readonly string[] = []): unknown {
  const { node, ref, cycle } = derefSpec(doc, schema, chain);
  if (cycle || !isObj(node) || depth > 5) return null;
  const next = ref ? [...chain, ref] : chain;
  if (node.example !== undefined) return node.example;
  if (Array.isArray(node.examples) && node.examples.length > 0) return node.examples[0];
  if (node.default !== undefined) return node.default;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  if (node.const !== undefined) return node.const;
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(node[key]) && node[key].length > 0) return exampleForSchema(doc, node[key][0], depth, next);
  }
  if (Array.isArray(node.allOf)) {
    const merged: Json = {};
    for (const part of node.allOf) {
      const value = exampleForSchema(doc, part, depth, next);
      if (isObj(value)) Object.assign(merged, value);
    }
    return merged;
  }
  const type = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;
  if (type === 'object' || (type === undefined && isObj(node.properties))) {
    const out: Json = {};
    for (const [name, prop] of Object.entries(isObj(node.properties) ? node.properties : {})) {
      const { node: p } = derefSpec(doc, prop, next);
      if (isObj(p) && p.readOnly === true) continue;
      out[name] = exampleForSchema(doc, prop, depth + 1, next);
    }
    return out;
  }
  if (type === 'array') return node.items === undefined ? [] : [exampleForSchema(doc, node.items, depth + 1, next)];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return true;
  if (type === 'string') {
    switch (node.format) {
      case 'date-time':
        return '2026-01-01T00:00:00Z';
      case 'date':
        return '2026-01-01';
      case 'uuid':
        return '00000000-0000-4000-8000-000000000000';
      case 'email':
        return 'user@example.com';
      case 'uri':
      case 'url':
        return 'https://example.com';
      default:
        return 'string';
    }
  }
  return null;
}

interface ParamDef {
  name: string;
  in: string;
  required: boolean;
  schema: unknown;
  example: unknown;
}

/** Path-level parameters, overridden by the operation's own of the same name + location. */
function parametersOf(doc: Json, op: Json, pathItem: unknown): ParamDef[] {
  const read = (list: unknown) =>
    (Array.isArray(list) ? list : [])
      .map((p) => derefSpec(doc, p).node)
      .filter(isObj)
      .map((p) => ({
        name: text(p.name) ?? '',
        in: text(p.in) ?? '',
        required: p.required === true || p.in === 'path',
        schema: p.schema,
        example: p.example ?? (isObj(p.examples) ? firstExample(p.examples) : undefined),
      }))
      .filter((p) => p.name && p.in);
  const own = read(op.parameters);
  const inherited = read(isObj(pathItem) ? pathItem.parameters : undefined).filter(
    (p) => !own.some((o) => o.name === p.name && o.in === p.in),
  );
  return [...inherited, ...own];
}

function firstExample(examples: unknown): unknown {
  if (!isObj(examples)) return undefined;
  const first = Object.values(examples)[0];
  return isObj(first) ? first.value : undefined;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** One way an operation authenticates, and the env var its placeholder reads. */
export interface OperationAuth {
  /** The `securitySchemes` key. */
  scheme: string;
  kind: 'bearer' | 'basic' | 'apiKey';
  /** Where an API key goes, and under what name. */
  in: 'header' | 'query' | 'cookie' | null;
  name: string | null;
  env: 'TOKEN' | 'BASIC_CREDENTIALS' | 'API_KEY';
}

/**
 * The schemes of the operation's first security requirement — the others are
 * alternatives to it — or of the spec's when the operation names none.
 */
export function operationAuth(doc: Json, op: { pointer: string }): OperationAuth[] {
  const raw = derefSpec(doc, resolveSpecPointer(doc, op.pointer)).node;
  const own = isObj(raw) && Array.isArray(raw.security) ? raw.security : null;
  const requirements = own ?? (Array.isArray(doc.security) ? doc.security : []);
  const first = requirements.find(isObj);
  const schemes = isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : {};
  const out: OperationAuth[] = [];
  for (const scheme of first ? Object.keys(first) : []) {
    const def = derefSpec(doc, schemes[scheme]).node;
    if (!isObj(def)) continue;
    const kind = text(def.type);
    if (kind === 'http' && text(def.scheme)?.toLowerCase() === 'basic') {
      out.push({ scheme, kind: 'basic', in: 'header', name: 'Authorization', env: 'BASIC_CREDENTIALS' });
    } else if (kind === 'http' || kind === 'oauth2' || kind === 'openIdConnect') {
      out.push({ scheme, kind: 'bearer', in: 'header', name: 'Authorization', env: 'TOKEN' });
    } else if (kind === 'apiKey') {
      const where = def.in === 'query' || def.in === 'cookie' ? def.in : 'header';
      out.push({ scheme, kind: 'apiKey', in: where, name: text(def.name) ?? 'X-API-Key', env: 'API_KEY' });
    }
  }
  return out;
}

/** Placeholder headers and query entries for an operation's auth. */
function authFor(doc: Json, op: { pointer: string }): { headers: SampleRequest['headers']; query: SampleRequest['query'] } {
  const headers: SampleRequest['headers'] = [];
  const query: SampleRequest['query'] = [];
  for (const a of operationAuth(doc, op)) {
    if (a.kind === 'basic') headers.push({ name: 'Authorization', value: ['Basic ', { env: a.env }] });
    else if (a.kind === 'bearer') headers.push({ name: 'Authorization', value: ['Bearer ', { env: a.env }] });
    else if (a.in === 'query') query.push({ name: a.name!, value: [{ env: a.env }] });
    else if (a.in === 'cookie') headers.push({ name: 'Cookie', value: [`${a.name}=`, { env: a.env }] });
    else headers.push({ name: a.name!, value: [{ env: a.env }] });
  }
  return { headers, query };
}

const isJsonType = (t: string) => /[/+]json\b/iu.test(t);

/**
 * The request an operation's sample describes: the console's values where it
 * has them, the spec's examples elsewhere, placeholders for credentials.
 * Null for an AsyncAPI operation — there is no HTTP request to print.
 */
export function sampleRequestFor(
  doc: Json,
  op: { method: string | null; path: string; pointer: string; protocol?: string },
  inputs: SampleInputs = {},
): SampleRequest | null {
  if (op.protocol === 'async' || !op.method) return null;
  const raw = derefSpec(doc, resolveSpecPointer(doc, op.pointer)).node;
  if (!isObj(raw)) return null;
  const pathItem = resolveSpecPointer(doc, op.pointer.slice(0, op.pointer.lastIndexOf('/')));
  const params = parametersOf(doc, raw, pathItem);
  const valueOf = (p: ParamDef, typed: Record<string, string> | undefined) =>
    typed?.[p.name] ?? scalar(p.example ?? exampleForSchema(doc, p.schema));

  const base = (inputs.serverUrl ?? apiServerOptions(doc)[0]?.url ?? '').replace(/\/+$/u, '');
  const path = op.path.replace(/\{([^}]+)\}/gu, (whole, name: string) => {
    const p = params.find((x) => x.in === 'path' && x.name === name);
    const typed = inputs.path?.[name];
    const value = typed ?? (p ? scalar(p.example ?? exampleForSchema(doc, p.schema)) : '');
    // An empty value keeps the template, so the sample still says what goes there.
    return value && value !== 'string' ? encodeURIComponent(value) : whole;
  });

  const auth = authFor(doc, op);
  const query = [
    ...params
      .filter((p) => p.in === 'query' && (p.required || inputs.query?.[p.name] !== undefined))
      .map((p) => ({ name: p.name, value: [valueOf(p, inputs.query)] as SampleText })),
    ...auth.query,
  ];

  const body = bodyFor(doc, raw, inputs);
  const headers: SampleRequest['headers'] = [
    ...params
      .filter((p) => p.in === 'header' && (p.required || inputs.headers?.[p.name] !== undefined))
      .map((p) => ({ name: p.name, value: [valueOf(p, inputs.headers)] as SampleText })),
    ...(body ? [{ name: 'Content-Type', value: [body.contentType] as SampleText }] : []),
    ...auth.headers,
  ];
  return { method: op.method.toUpperCase(), url: `${base}${path}`, query, headers, body };
}

function bodyFor(doc: Json, op: Json, inputs: SampleInputs): SampleRequest['body'] {
  const requestBody = derefSpec(doc, op.requestBody).node;
  const content = isObj(requestBody) && isObj(requestBody.content) ? requestBody.content : null;
  const types = content ? Object.keys(content) : [];
  if (types.length === 0 && inputs.body == null) return null;
  const contentType = inputs.contentType ?? types.find(isJsonType) ?? types[0] ?? 'application/json';
  const media = content && isObj(content[contentType]) ? (content[contentType] as Json) : {};

  if (inputs.body != null) {
    if (isJsonType(contentType)) {
      try {
        const json: unknown = JSON.parse(inputs.body);
        return { contentType, text: JSON.stringify(json, null, 2), json };
      } catch {
        // Not JSON yet — print what was typed.
      }
    }
    return { contentType, text: inputs.body };
  }
  const example = media.example ?? firstExample(media.examples) ?? exampleForSchema(doc, media.schema);
  if (contentType === 'application/x-www-form-urlencoded' && isObj(example)) {
    return {
      contentType,
      text: Object.entries(example)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(scalar(v))}`)
        .join('&'),
    };
  }
  if (isJsonType(contentType) || typeof example !== 'string') {
    return { contentType, text: JSON.stringify(example ?? {}, null, 2), json: example ?? {} };
  }
  return { contentType, text: example };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** The URL with its query, as one text: literal runs encoded, env parts kept. */
function fullUrl(req: SampleRequest, withQuery = true): SampleText {
  const out: SampleText = [req.url];
  if (withQuery) {
    req.query.forEach((q, i) => {
      out.push(`${i === 0 ? '?' : '&'}${encodeURIComponent(q.name)}=`);
      for (const part of q.value) out.push(typeof part === 'string' ? encodeURIComponent(part) : part);
    });
  }
  return merge(out);
}

function merge(parts: SampleText): SampleText {
  const out: SampleText = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (typeof part === 'string' && typeof last === 'string') out[out.length - 1] = last + part;
    else if (part !== '') out.push(part);
  }
  return out;
}

const hasEnv = (t: SampleText) => t.some((p) => typeof p !== 'string');
const literal = (t: SampleText) => t.map((p) => (typeof p === 'string' ? p : '')).join('');
/** A JSON string literal, which JS, Python and Go all read as the same string. */
const quoted = (s: string) => JSON.stringify(s);

const shell = {
  str(t: SampleText): string {
    if (!hasEnv(t)) return `'${literal(t).replace(/'/gu, `'\\''`)}'`;
    return `"${t.map((p) => (typeof p === 'string' ? p.replace(/[\\"`$]/gu, (c) => `\\${c}`) : `$${p.env}`)).join('')}"`;
  },
};

function curl(req: SampleRequest): string {
  const lines = [`curl --request ${req.method}`, `--url ${shell.str(fullUrl(req))}`];
  for (const h of req.headers) lines.push(`--header ${shell.str([`${h.name}: `, ...h.value])}`);
  if (req.body) lines.push(`--data ${shell.str([req.body.text])}`);
  return lines.join(' \\\n  ');
}

const js = {
  str(t: SampleText): string {
    if (!hasEnv(t)) return quoted(literal(t));
    const inner = t
      .map((p) => (typeof p === 'string' ? p.replace(/[\\`]|\$\{/gu, (c) => `\\${c}`) : `\${process.env.${p.env}}`))
      .join('');
    return `\`${inner}\``;
  },
};

function javascript(req: SampleRequest): string {
  const options: string[] = [`  method: ${quoted(req.method)},`];
  if (req.headers.length) {
    options.push('  headers: {');
    for (const h of req.headers) options.push(`    ${quoted(h.name)}: ${js.str(h.value)},`);
    options.push('  },');
  }
  if (req.body) {
    const value =
      req.body.json !== undefined
        ? `JSON.stringify(${indent(JSON.stringify(req.body.json, null, 2), '  ')})`
        : js.str([req.body.text]);
    options.push(`  body: ${value},`);
  }
  return [
    `const response = await fetch(${js.str(fullUrl(req))}, {`,
    ...options,
    '});',
    '',
    'console.log(response.status, await response.text());',
  ].join('\n');
}

const py = {
  str(t: SampleText): string {
    if (!hasEnv(t)) return quoted(literal(t));
    const inner = t
      .map((p) => (typeof p === 'string' ? quoted(p).slice(1, -1).replace(/[{}]/gu, (c) => c + c) : `{os.environ['${p.env}']}`))
      .join('');
    return `f"${inner}"`;
  },
  /** A JSON value as a Python literal. */
  value(v: unknown, pad = ''): string {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return quoted(v);
    const next = `${pad}    `;
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return `[\n${v.map((x) => `${next}${py.value(x, next)},`).join('\n')}\n${pad}]`;
    }
    const entries = Object.entries(v as Json);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([k, x]) => `${next}${quoted(k)}: ${py.value(x, next)},`).join('\n')}\n${pad}}`;
  },
};

function python(req: SampleRequest): string {
  const usesEnv = req.headers.some((h) => hasEnv(h.value)) || req.query.some((q) => hasEnv(q.value));
  const args: string[] = [`    ${quoted(req.method)},`, `    ${quoted(req.url)},`];
  if (req.query.length) {
    args.push('    params={');
    for (const q of req.query) args.push(`        ${quoted(q.name)}: ${py.str(q.value)},`);
    args.push('    },');
  }
  if (req.headers.length) {
    args.push('    headers={');
    for (const h of req.headers) args.push(`        ${quoted(h.name)}: ${py.str(h.value)},`);
    args.push('    },');
  }
  if (req.body) {
    args.push(
      req.body.json !== undefined ? `    json=${py.value(req.body.json, '    ')},` : `    data=${quoted(req.body.text)},`,
    );
  }
  return [
    ...(usesEnv ? ['import os', ''] : []),
    'import requests',
    '',
    'response = requests.request(',
    ...args,
    ')',
    '',
    'print(response.status_code, response.text)',
  ].join('\n');
}

const go = {
  str(t: SampleText): string {
    const parts = merge(t).map((p) => (typeof p === 'string' ? quoted(p) : `os.Getenv(${quoted(p.env)})`));
    return parts.length ? parts.join(' + ') : '""';
  },
};

function golang(req: SampleRequest): string {
  const usesEnv = req.headers.some((h) => hasEnv(h.value)) || req.query.some((q) => hasEnv(q.value));
  const imports = ['fmt', 'io', 'net/http', ...(usesEnv ? ['os'] : []), ...(req.body ? ['strings'] : [])];
  const body = req.body
    ? req.body.text.includes('`')
      ? quoted(req.body.text)
      : `\`${req.body.text}\``
    : null;
  return [
    'package main',
    '',
    'import (',
    ...imports.map((i) => `\t${quoted(i)}`),
    ')',
    '',
    'func main() {',
    ...(body ? [`\tbody := strings.NewReader(${body})`] : []),
    `\treq, err := http.NewRequest(${quoted(req.method)}, ${go.str(fullUrl(req))}, ${body ? 'body' : 'nil'})`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    ...req.headers.map((h) => `\treq.Header.Set(${quoted(h.name)}, ${go.str(h.value)})`),
    '',
    '\tres, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer res.Body.Close()',
    '',
    '\tout, _ := io.ReadAll(res.Body)',
    '\tfmt.Println(res.Status, string(out))',
    '}',
  ].join('\n');
}

function indent(s: string, pad: string): string {
  return s.split('\n').join(`\n${pad}`);
}

const PRINTERS: Record<CodeSampleLang, (req: SampleRequest) => string> = {
  curl,
  javascript,
  python,
  go: golang,
};

export function renderCodeSample(lang: CodeSampleLang, req: SampleRequest): string {
  return PRINTERS[lang](req);
}

/** How `x-codeSamples` spells a language, folded onto ours. */
const SPEC_LANG_ALIASES: Record<string, CodeSampleLang> = {
  curl: 'curl',
  shell: 'curl',
  bash: 'curl',
  sh: 'curl',
  javascript: 'javascript',
  js: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  typescript: 'javascript',
  python: 'python',
  python3: 'python',
  py: 'python',
  go: 'go',
  golang: 'go',
};

/** The author's samples (`x-codeSamples`, or the older `x-code-samples`), by our language. */
export function specCodeSamples(op: unknown): Partial<Record<CodeSampleLang, { source: string; label: string | null }>> {
  if (!isObj(op)) return {};
  const list = Array.isArray(op['x-codeSamples']) ? op['x-codeSamples'] : Array.isArray(op['x-code-samples']) ? op['x-code-samples'] : [];
  const out: Partial<Record<CodeSampleLang, { source: string; label: string | null }>> = {};
  for (const entry of list) {
    if (!isObj(entry)) continue;
    const lang = SPEC_LANG_ALIASES[(text(entry.lang) ?? '').toLowerCase().replace(/[\s_.-]+/gu, '')];
    const source = typeof entry.source === 'string' ? entry.source : null;
    // The first sample per language wins, as the spec lists them.
    if (lang && source && !out[lang]) out[lang] = { source, label: text(entry.label) };
  }
  return out;
}

/**
 * Every language's sample for one operation: the author's where the spec has
 * one, generated elsewhere. Empty for an AsyncAPI operation.
 */
export function codeSamplesFor(
  doc: Json,
  op: { method: string | null; path: string; pointer: string; protocol?: string },
  inputs: SampleInputs = {},
  langs: readonly CodeSampleLang[] = CODE_SAMPLE_LANGS,
): CodeSample[] {
  const req = sampleRequestFor(doc, op, inputs);
  if (!req) return [];
  const own = specCodeSamples(derefSpec(doc, resolveSpecPointer(doc, op.pointer)).node);
  return langs.map((lang) => {
    const spec = own[lang];
    return spec
      ? { lang, source: spec.source, origin: 'spec' as const, label: spec.label }
      : { lang, source: renderCodeSample(lang, req), origin: 'generated' as const, label: null };
  });
}

/**
 * The request a sample describes, with each placeholder replaced by the value
 * the person supplied — what the try-it console sends. An empty value drops
 * that header or query entry rather than sending `Bearer ` with nothing after.
 */
export function resolveSampleRequest(
  req: SampleRequest,
  env: Partial<Record<string, string>>,
): { method: string; url: string; headers: Array<{ name: string; value: string }>; body: string | null } {
  const fill = (t: SampleText): string | null => {
    let out = '';
    for (const part of t) {
      if (typeof part === 'string') out += part;
      else if (env[part.env]) out += env[part.env];
      else return null;
    }
    return out;
  };
  const query = req.query
    .map((q) => [q.name, fill(q.value)] as const)
    .filter((q): q is readonly [string, string] => q[1] !== null)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  return {
    method: req.method,
    url: query.length ? `${req.url}?${query.join('&')}` : req.url,
    headers: req.headers
      .map((h) => ({ name: h.name, value: fill(h.value) }))
      .filter((h): h is { name: string; value: string } => h.value !== null),
    body: req.body?.text ?? null,
  };
}
