import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { dump as dumpYaml, load as parseYaml } from 'js-yaml';
import { apiSpecGlobs, type ApiSpecKind, type ApiSpecSyntax, type Locale } from '@knowledge/contracts';
import { globToRegExp } from '../../common/glob.js';
import { t } from '../../i18n/t.js';

/**
 * API spec files in a repository archive (#78, phase 7). Shared by the
 * `markdown-git` and `codebase` adapters, which read the same archive, and
 * free of Nest and I/O so the bundling rules are tested on a plain map.
 *
 * A spec is one document here, so a spec split across files is bundled at
 * sync time: every relative `$ref` into a sibling file in the same snapshot is
 * inlined. A remote `$ref` is never fetched — it is left as written and
 * reported, and the parser refuses it at finalize, which is the same answer an
 * upload gets.
 */

/** Only these extensions are ever specs; a `.md` file is the markdown path's. */
const SPEC_EXTENSIONS = /\.(ya?ml|json)$/iu;

/** How much of a file the discovery sniff reads; the top-level key is near the top. */
const SNIFF_BYTES = 4096;

/** Discovery offers at most this many, shallowest first. */
export const MAX_SPEC_SUGGESTIONS = 20;

/** Bound on distinct external targets inlined into one spec — a guard, not a limit anyone meets. */
const MAX_BUNDLED_TARGETS = 2000;

export interface RepoSpecFile {
  path: string;
  kind: ApiSpecKind;
  syntax: ApiSpecSyntax;
  /** `info.title`, else the file name. */
  title: string;
  /** The bundled text: the file's own bytes when nothing needed inlining. */
  text: string;
  /** Hash of the bundled text — so a change to a referenced sibling is a change to the spec. */
  version: string;
  warnings: string[];
}

/** Why a `$ref` was left as written. */
export interface BundleIssue {
  reason: 'remote' | 'missing' | 'outside' | 'unreadable';
  ref: string;
  /** The file the `$ref` was written in. */
  file: string;
}

export interface BundledSpec {
  document: Record<string, unknown>;
  /** True when at least one external `$ref` was inlined, so the text was re-serialized. */
  changed: boolean;
  issues: BundleIssue[];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The kind a parsed document declares by its top-level key, or null. A file
 * matched by a glob that declares neither is a fragment — `schemas/user.yaml`
 * under `specs/**` — and is skipped quietly: it reaches readers through the
 * spec that references it.
 */
export function specKindOf(value: unknown): ApiSpecKind | null {
  if (!isObject(value)) return null;
  if (typeof value.openapi === 'string' || typeof value.swagger === 'string') return 'openapi';
  if (typeof value.asyncapi === 'string') return 'asyncapi';
  return null;
}

/**
 * Cheap discovery sniff: the first few KB, for an `openapi:` / `swagger:` /
 * `asyncapi:` key at the start of a line (YAML) or as a JSON property. Never
 * parses — this runs over every YAML and JSON file in a repository while a
 * person waits in the setup dialog.
 */
export function looksLikeSpec(path: string, bytes: Uint8Array): boolean {
  if (!SPEC_EXTENSIONS.test(path)) return false;
  const head = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString('utf8');
  return /^\s*["']?(?:openapi|swagger|asyncapi)["']?\s*:/mu.test(head);
}

/** Spec files a connector could sync, for the setup dialog to offer (#78). */
export function suggestSpecFiles(files: Map<string, Uint8Array>): string[] {
  return [...files.entries()]
    .filter(([path, bytes]) => looksLikeSpec(path, bytes))
    .map(([path]) => path)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, MAX_SPEC_SUGGESTIONS);
}

// ---------------------------------------------------------------------------
// The connector's spec set
// ---------------------------------------------------------------------------

/** Per archive and glob set: list, children and fetch all ask, and the answer is one walk. */
const cache = new WeakMap<Map<string, Uint8Array>, Map<string, Map<string, RepoSpecFile>>>();

/**
 * Every file under the connector's `apiSpecs` globs that declares itself a
 * spec, bundled. Empty when the connector names no globs, which is every
 * connector that existed before this phase.
 */
export function repoSpecFiles(
  files: Map<string, Uint8Array>,
  config: Record<string, unknown>,
  locale: Locale,
): Map<string, RepoSpecFile> {
  const globs = apiSpecGlobs(config);
  if (globs.length === 0) return new Map();
  const key = `${locale}\n${globs.join('\n')}`;
  let perArchive = cache.get(files);
  const hit = perArchive?.get(key);
  if (hit) return hit;

  const patterns = globs.map(globToRegExp);
  const out = new Map<string, RepoSpecFile>();
  for (const path of [...files.keys()].sort()) {
    if (!SPEC_EXTENSIONS.test(path) || !patterns.some((p) => p.test(path))) continue;
    const spec = readSpecFile(path, files, locale);
    if (spec) out.set(path, spec);
  }

  if (!perArchive) {
    perArchive = new Map();
    cache.set(files, perArchive);
  }
  perArchive.set(key, out);
  return out;
}

function readSpecFile(path: string, files: Map<string, Uint8Array>, locale: Locale): RepoSpecFile | null {
  const raw = Buffer.from(files.get(path)!).toString('utf8');
  const syntax: ApiSpecSyntax = /\.json$/iu.test(path) ? 'json' : 'yaml';
  let value: unknown;
  try {
    value = parseSource(raw, syntax);
  } catch {
    // Not even YAML. If it was meant to be a spec the parser's message at
    // finalize is the useful one, but a broken fixture under a broad glob is
    // more likely, and is skipped the way any other non-spec is.
    return null;
  }
  const kind = specKindOf(value);
  if (!kind) return null;

  const bundled = bundleSpec(path, files);
  const text = !bundled.changed
    ? raw
    : syntax === 'json'
      ? `${JSON.stringify(bundled.document, null, 2)}\n`
      : dumpYaml(bundled.document, { noRefs: true, lineWidth: -1 });

  const info = isObject(bundled.document.info) ? bundled.document.info : {};
  const warnings = bundled.issues.map((issue) =>
    t(`connector.warning.apiSpec.${issue.reason}`, { ref: issue.ref, file: issue.file }, locale),
  );
  if (bundled.changed) warnings.unshift(t('connector.warning.apiSpec.bundled', {}, locale));

  return {
    path,
    kind,
    syntax,
    title: (typeof info.title === 'string' && info.title.trim()) || (path.split('/').pop() ?? path),
    text,
    version: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

/**
 * One spec document from an entry file and the relative files it references.
 *
 * The first `$ref` to a target is replaced by the target's content, and every
 * later `$ref` to the same target — including one from inside it, which is
 * how a recursive schema across files ends — becomes an internal `$ref` to
 * where it was placed. That keeps shared schemas shared and cycles finite, and
 * the result reads like a hand-written single-file spec rather than a list of
 * hoisted fragments. A `#/…` reference inside a referenced file is that file's,
 * so it is resolved the same way; one in the entry file is left alone.
 */
export function bundleSpec(entry: string, files: Map<string, Uint8Array>): BundledSpec {
  const issues: BundleIssue[] = [];
  const parsed = new Map<string, unknown>();
  const placed = new Map<string, string>();
  let changed = false;

  const load = (file: string): unknown => {
    if (parsed.has(file)) return parsed.get(file);
    const bytes = files.get(file);
    let value: unknown;
    if (bytes) {
      try {
        value = parseSource(Buffer.from(bytes).toString('utf8'), /\.json$/iu.test(file) ? 'json' : 'yaml');
      } catch {
        value = undefined;
      }
    }
    parsed.set(file, value);
    return value;
  };

  /** A copy of `node` at `pointer` in the output, with its external refs resolved from `file`. */
  const walk = (node: unknown, file: string, pointer: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, file, `${pointer}/${i}`));
    if (!isObject(node)) return node;

    const ref = node.$ref;
    if (typeof ref === 'string') {
      const resolved = resolveRef(ref, file, entry);
      if (resolved.kind === 'internal') return copyWalk(node, file, pointer);
      // Back into the entry: its content keeps its own pointers in the output.
      if (resolved.kind === 'file' && resolved.file === entry) {
        const { $ref: _ref, ...rest } = node;
        return { ...walkObject(rest, file, pointer), $ref: `#${resolved.fragment}` };
      }
      if (resolved.kind !== 'file') {
        issues.push({ reason: resolved.kind, ref, file });
        return copyWalk(node, file, pointer);
      }

      const target = `${resolved.file}#${resolved.fragment}`;
      const already = placed.get(target);
      const { $ref: _ref, ...siblings } = node;
      if (already !== undefined) return { ...walkObject(siblings, file, pointer), $ref: `#${already}` };

      const doc = load(resolved.file);
      const fragment = doc === undefined ? undefined : atPointer(doc, resolved.fragment);
      if (fragment === undefined || placed.size >= MAX_BUNDLED_TARGETS) {
        issues.push({ reason: doc === undefined ? 'missing' : 'unreadable', ref, file });
        return copyWalk(node, file, pointer);
      }

      // Recorded before descending, so a reference back to this target from
      // inside it resolves to here instead of inlining forever.
      placed.set(target, pointer);
      changed = true;
      const inlined = walk(fragment, resolved.file, pointer);
      // `$ref` siblings (a 3.1 `description` beside it) override the target's own.
      return isObject(inlined) && Object.keys(siblings).length > 0
        ? { ...inlined, ...walkObject(siblings, file, pointer) }
        : inlined;
    }
    return walkObject(node, file, pointer);
  };

  const walkObject = (node: Record<string, unknown>, file: string, pointer: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, file, `${pointer}/${escapePointer(k)}`);
    return out;
  };

  /**
   * A `$ref` kept as written — internal to the entry, remote, or broken. Its
   * siblings are still walked. An internal ref inside a *referenced* file
   * cannot stay as written (it would point into the entry), so it is resolved
   * through `resolveRef` above before ever reaching here.
   */
  const copyWalk = (node: Record<string, unknown>, file: string, pointer: string): Record<string, unknown> => {
    const { $ref, ...rest } = node;
    return { ...walkObject(rest, file, pointer), $ref };
  };

  const root = load(entry);
  if (!isObject(root)) return { document: {}, changed: false, issues };
  const document = walkObject(root, entry, '');
  return { document, changed, issues };
}

type ResolvedRef =
  | { kind: 'internal' }
  | { kind: 'file'; file: string; fragment: string }
  | { kind: 'remote' | 'outside' };

/**
 * Where a `$ref` written in `file` points. `#/x` in the entry stays internal;
 * `#/x` anywhere else is that file's own. A scheme or `//` is remote. A path
 * that climbs out of the repository is refused — the archive has nothing
 * there, and a `$ref` is not a way to name an arbitrary path.
 */
function resolveRef(ref: string, file: string, entry: string): ResolvedRef {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(ref) || ref.startsWith('//')) return { kind: 'remote' };
  const hash = ref.indexOf('#');
  const path = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? '' : ref.slice(hash + 1);
  if (path === '') return file === entry ? { kind: 'internal' } : { kind: 'file', file, fragment };

  const joined = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(path)));
  if (joined.startsWith('../') || joined === '..' || posix.isAbsolute(joined)) return { kind: 'outside' };
  return { kind: 'file', file: joined, fragment };
}

/** RFC 6901, plus the URI-encoding a `$ref` fragment may carry. */
function atPointer(doc: unknown, fragment: string): unknown {
  if (fragment === '' || fragment === '/') return doc;
  if (!fragment.startsWith('/')) return undefined;
  let cur: unknown = doc;
  for (const raw of fragment.slice(1).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isObject(cur)) cur = Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : undefined;
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function parseSource(raw: string, syntax: ApiSpecSyntax): unknown {
  return syntax === 'json' ? JSON.parse(raw) : parseYaml(raw);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
