import { posix } from 'node:path';
import type { RepoMap, RepoModule } from './repo-map.js';

/**
 * Which module an import lands in (docs/features/46).
 *
 * Feature 27 dropped relative imports as noise and kept bare ones as
 * "dependencies", which was right for a module page and leaves the
 * architecture diagram with nothing to draw. This resolves both kinds against
 * the module map, and nothing else — no TypeScript path aliases, no Python
 * package roots, no Go module paths beyond the manifest's own name:
 *
 * - **Bare specifiers** match a module's manifest name, exactly or as a subpath
 *   (`@knowledge/contracts/core` → `packages/contracts`). This works in every
 *   ecosystem whose manifests carry a name: npm, Go, Cargo, Python.
 * - **Relative specifiers** (`./x`, `../y`) are resolved as paths, which is
 *   only meaningful for ECMAScript-family files — the one case where the
 *   specifier *is* a path. The resolved path is assigned to the deepest module
 *   root that contains it, the same rule `buildRepoMap` assigns files by.
 *
 * Anything else is external. The coarseness for other languages is stated on
 * the architecture page rather than hidden.
 */

export interface ModuleEdges {
  /** from module key → to module key → how many imports cross that way. */
  internal: Map<string, Map<string, number>>;
  /** from module key → bare specifiers that matched no module, reduced to their package. */
  external: Map<string, Set<string>>;
}

const ECMA_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;

export function resolveModuleEdges(map: RepoMap, importsByFile: Map<string, string[]>): ModuleEdges {
  const byName = new Map<string, RepoModule>();
  for (const module of map.modules) if (module.manifest?.name) byName.set(module.manifest.name, module);
  const roots = map.modules.map((m) => m.path);
  const byPath = new Map(map.modules.map((m) => [m.path, m]));
  const ownerOf = new Map<string, RepoModule>();
  for (const module of map.modules) for (const file of module.files) ownerOf.set(file, module);

  const internal = new Map<string, Map<string, number>>();
  const external = new Map<string, Set<string>>();

  for (const [file, specifiers] of importsByFile) {
    const from = ownerOf.get(file);
    if (!from) continue;
    for (const specifier of specifiers) {
      let to: RepoModule | null = null;
      if (specifier.startsWith('.')) {
        if (!ECMA_FILE.test(file)) continue;
        const root = deepestRoot(posix.normalize(posix.join(posix.dirname(file), specifier)), roots);
        to = root === null ? null : (byPath.get(root) ?? null);
        // A relative import that stays home is the module's own business.
        if (!to || to === from) continue;
      } else if (specifier.startsWith('/')) {
        continue;
      } else {
        to = matchByName(specifier, byName);
        if (!to) {
          const set = external.get(from.key) ?? new Set<string>();
          set.add(packageOf(specifier));
          external.set(from.key, set);
          continue;
        }
        if (to === from) continue;
      }
      const row = internal.get(from.key) ?? new Map<string, number>();
      row.set(to.key, (row.get(to.key) ?? 0) + 1);
      internal.set(from.key, row);
    }
  }

  return { internal, external };
}

/**
 * The edges as stable text — what the architecture page's version hashes.
 * Counts are left out on purpose: one more call site between two modules that
 * already depend on each other changes no box and no arrow.
 */
export function edgeDigest(edges: ModuleEdges): string[] {
  const lines: string[] = [];
  for (const [from, row] of edges.internal) for (const to of row.keys()) lines.push(`${from}->${to}`);
  for (const [from, set] of edges.external) for (const pkg of set) lines.push(`${from}=>${pkg}`);
  return lines.sort();
}

function matchByName(specifier: string, byName: Map<string, RepoModule>): RepoModule | null {
  let best: RepoModule | null = null;
  let bestLength = 0;
  for (const [name, module] of byName) {
    if ((specifier === name || specifier.startsWith(`${name}/`)) && name.length > bestLength) {
      best = module;
      bestLength = name.length;
    }
  }
  return best;
}

/** `@scope/pkg/sub` → `@scope/pkg`, `lodash/fp` → `lodash`, `github.com/a/b/c` → `github.com/a/b`. */
export function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  if (parts[0].includes('.') && parts.length >= 3) return parts.slice(0, 3).join('/');
  return parts[0].split('::')[0];
}

function deepestRoot(path: string, roots: string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    const matches = root === '' || path === root || path.startsWith(`${root}/`);
    if (matches && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

const ECMA_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.d.ts'];

/**
 * The file a relative ECMAScript import names, or null. NodeNext writes `./x.js`
 * for a sibling `x.ts`, and bundlers allow the extension and `/index` to be
 * left off, so each of those spellings is tried against the archive.
 */
export function resolveRelativeFile(fromFile: string, specifier: string, files: Map<string, Uint8Array>): string | null {
  if (!specifier.startsWith('.') || !ECMA_FILE.test(fromFile)) return null;
  return firstFile(posix.join(posix.dirname(fromFile), specifier), files);
}

/** `base` as written, then with each ECMAScript extension, then as a directory's index. */
function firstFile(path: string, files: Map<string, Uint8Array>): string | null {
  const base = posix.normalize(path).replace(/^\.\//, '');
  const stem = base.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  const candidates = [
    base,
    ...ECMA_EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...ECMA_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((c) => files.has(c)) ?? null;
}

// --- file → file resolution (#236) ---

/**
 * Which file an import names, or null when it is outside the repository or
 * cannot be told — the code-usage index's resolver (#236).
 *
 * `resolveModuleEdges` above stops at the module; this goes to the file, and
 * covers what that one skips for ECMAScript-family importers:
 *
 * - **relative** specifiers, as `resolveRelativeFile` always has;
 * - **`tsconfig` `paths`** (`@/components/X.vue`), read from the nearest
 *   directory holding a `tsconfig*.json` — every config there, because a Vite
 *   app splits itself into `tsconfig.app.json` and friends — following
 *   `extends` inside the repository; then that config's `baseUrl`;
 * - **workspace packages** (`@knowledge/contracts/core`), by any `package.json`
 *   in the archive whose `name` the specifier starts with, through its
 *   `exports` map (conditions tried in order, subpath patterns allowed) or its
 *   `main` when it has none.
 *
 * For Python only relative imports resolve (`.x` → `x.py` or `x/__init__.py`).
 * Every other language resolves nothing: a Go import path, a Rust `use` or a
 * Java package needs a module root this does not model.
 */
export type FileResolver = (fromFile: string, specifier: string) => string | null;

const PY_FILE = /\.pyi?$/;
const TSCONFIG = /(?:^|\/)tsconfig[^/]*\.json$/;
/** `extends` chains are followed this deep; a cycle stops here rather than spinning. */
const MAX_EXTENDS = 8;

interface PathAlias {
  /** The pattern before and after its `*`; `star` false = an exact pattern. */
  prefix: string;
  suffix: string;
  star: boolean;
  /** Repo-relative, still holding their `*`. */
  targets: string[];
}

interface AliasConfig {
  paths: PathAlias[];
  baseUrl: string | null;
}

interface WorkspacePackage {
  name: string;
  dir: string;
  exports: unknown;
  main: string | null;
}

export function createFileResolver(files: Map<string, Uint8Array>): FileResolver {
  const packages = workspacePackages(files);
  const configsByDir = new Map<string, string[]>();
  for (const path of files.keys()) {
    if (!TSCONFIG.test(path)) continue;
    const dir = dirOf(path);
    configsByDir.set(dir, [...(configsByDir.get(dir) ?? []), path].sort());
  }
  const aliasesByDir = new Map<string, AliasConfig[]>();

  const aliasesFor = (dir: string): AliasConfig[] => {
    const cached = aliasesByDir.get(dir);
    if (cached) return cached;
    const own = configsByDir.get(dir);
    const found = own
      ? own.map((path) => loadTsconfig(path, files, packages, 0))
      : dir === ''
        ? []
        : aliasesFor(dirOf(dir));
    aliasesByDir.set(dir, found);
    return found;
  };

  return (fromFile, specifier) => {
    if (specifier.startsWith('.')) {
      return PY_FILE.test(fromFile)
        ? resolvePythonRelative(fromFile, specifier, files)
        : resolveRelativeFile(fromFile, specifier, files);
    }
    if (!ECMA_FILE.test(fromFile) || specifier.startsWith('/') || specifier.includes(':')) return null;
    const configs = aliasesFor(dirOf(fromFile));
    for (const config of configs) {
      const hit = resolveAlias(specifier, config, files);
      if (hit) return hit;
    }
    return resolvePackage(specifier, packages, files);
  };
}

/** `.x` → `x.py` | `x/__init__.py` beside the importer; each extra dot climbs one directory. */
function resolvePythonRelative(fromFile: string, specifier: string, files: Map<string, Uint8Array>): string | null {
  const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  let dir = dirOf(fromFile);
  for (let i = 1; i < dots; i += 1) {
    if (dir === '') return null;
    dir = dirOf(dir);
  }
  const rest = specifier.slice(dots).replace(/\./g, '/');
  const base = rest ? (dir ? `${dir}/${rest}` : rest) : dir;
  const candidates = rest ? [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`] : [dir ? `${dir}/__init__.py` : '__init__.py'];
  return candidates.find((c) => files.has(c)) ?? null;
}

/** Longest pattern prefix wins, as in TypeScript; an exact pattern beats a wildcard. Then `baseUrl`. */
function resolveAlias(specifier: string, config: AliasConfig, files: Map<string, Uint8Array>): string | null {
  let best: { alias: PathAlias; middle: string } | null = null;
  for (const alias of config.paths) {
    if (!alias.star) {
      if (specifier === alias.prefix) {
        best = { alias, middle: '' };
        break;
      }
      continue;
    }
    if (
      specifier.length >= alias.prefix.length + alias.suffix.length &&
      specifier.startsWith(alias.prefix) &&
      specifier.endsWith(alias.suffix) &&
      (!best || alias.prefix.length > best.alias.prefix.length)
    ) {
      best = { alias, middle: specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length) };
    }
  }
  if (best) {
    for (const target of best.alias.targets) {
      const hit = firstFile(target.replace('*', best.middle), files);
      if (hit) return hit;
    }
  }
  return config.baseUrl === null ? null : firstFile(posix.join(config.baseUrl, specifier), files);
}

/**
 * A `tsconfig`'s `paths` and `baseUrl`, its `extends` chain applied. A child's
 * `paths` replaces its parent's whole, as in TypeScript, and each target is
 * made repo-relative against the `baseUrl` in force, else the declaring file.
 */
function loadTsconfig(
  path: string,
  files: Map<string, Uint8Array>,
  packages: WorkspacePackage[],
  depth: number,
): AliasConfig {
  const json = readJson(files, path, true);
  const options = isRecord(json?.compilerOptions) ? json.compilerOptions : {};
  const dir = dirOf(path);

  let inherited: AliasConfig = { paths: [], baseUrl: null };
  if (depth < MAX_EXTENDS) {
    const parents = typeof json?.extends === 'string' ? [json.extends] : Array.isArray(json?.extends) ? json.extends : [];
    for (const parent of parents) {
      const parentPath = typeof parent === 'string' ? tsconfigPath(dir, parent, files, packages) : null;
      if (!parentPath) continue;
      const loaded = loadTsconfig(parentPath, files, packages, depth + 1);
      inherited = {
        paths: loaded.paths.length > 0 ? loaded.paths : inherited.paths,
        baseUrl: loaded.baseUrl ?? inherited.baseUrl,
      };
    }
  }

  const baseUrl = typeof options.baseUrl === 'string' ? repoPath(dir, options.baseUrl) : inherited.baseUrl;
  if (!isRecord(options.paths)) return { paths: inherited.paths, baseUrl };
  const root = baseUrl ?? dir;
  const paths: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(options.paths)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf('*');
    paths.push({
      prefix: star < 0 ? pattern : pattern.slice(0, star),
      suffix: star < 0 ? '' : pattern.slice(star + 1),
      star: star >= 0,
      targets: targets.filter((t): t is string => typeof t === 'string').map((t) => repoPath(root, t)),
    });
  }
  return { paths, baseUrl };
}

/** Where an `extends` value points, inside the repository — or null for a config from npm. */
function tsconfigPath(dir: string, value: string, files: Map<string, Uint8Array>, packages: WorkspacePackage[]): string | null {
  const withJson = (p: string): string | null => [p, `${p}.json`, `${p}/tsconfig.json`].find((c) => files.has(c)) ?? null;
  if (value.startsWith('.')) return withJson(repoPath(dir, value));
  const pkg = packageFor(value, packages);
  if (!pkg) return null;
  const rest = value.slice(pkg.name.length).replace(/^\//, '');
  return withJson(rest ? repoPath(pkg.dir, rest) : repoPath(pkg.dir, 'tsconfig.json'));
}

function resolvePackage(specifier: string, packages: WorkspacePackage[], files: Map<string, Uint8Array>): string | null {
  const pkg = packageFor(specifier, packages);
  if (!pkg) return null;
  const subpath = specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`;
  if (pkg.exports !== null && pkg.exports !== undefined) {
    for (const target of exportTargets(pkg.exports, subpath)) {
      const hit = firstFile(repoPath(pkg.dir, target), files);
      if (hit) return hit;
    }
    // A package with `exports` hides every other path, by Node's own rule.
    return null;
  }
  const entry = subpath === '.' ? (pkg.main ?? 'index') : subpath;
  return firstFile(repoPath(pkg.dir, entry), files);
}

/**
 * The paths an `exports` map gives `subpath`, in the order to try them: every
 * string under its conditions in declared order, since which condition points
 * at source rather than build output is the package's business.
 */
function exportTargets(exports: unknown, subpath: string): string[] {
  const keyed = isRecord(exports) && Object.keys(exports).some((k) => k.startsWith('.'));
  const map: Record<string, unknown> = keyed ? (exports as Record<string, unknown>) : { '.': exports };
  if (subpath in map) return conditionStrings(map[subpath]);
  let best: { key: string; middle: string } | null = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      if (!best || prefix.length > best.key.indexOf('*')) {
        best = { key, middle: subpath.slice(prefix.length, subpath.length - suffix.length) };
      }
    }
  }
  if (!best) return [];
  const middle = best.middle;
  return conditionStrings(map[best.key]).map((t) => t.replace('*', middle));
}

function conditionStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(conditionStrings);
  if (isRecord(value)) return Object.values(value).flatMap(conditionStrings);
  return [];
}

function packageFor(specifier: string, packages: WorkspacePackage[]): WorkspacePackage | null {
  let best: WorkspacePackage | null = null;
  for (const pkg of packages) {
    if ((specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) && (!best || pkg.name.length > best.name.length)) {
      best = pkg;
    }
  }
  return best;
}

function workspacePackages(files: Map<string, Uint8Array>): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const path of files.keys()) {
    if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
    const json = readJson(files, path, false);
    if (typeof json?.name !== 'string' || !json.name) continue;
    out.push({
      name: json.name,
      dir: dirOf(path),
      exports: json.exports ?? null,
      main: typeof json.main === 'string' ? json.main : typeof json.module === 'string' ? json.module : null,
    });
  }
  return out;
}

/** One barrel's re-exports from one resolved file: exported name → name taken there, and `export *`. */
export interface Reexport {
  target: string;
  star: boolean;
  names: Record<string, string>;
}

/** importer → imported → names taken. */
export type ImportEdges = Map<string, Map<string, Set<string>>>;

/**
 * Carry each import through the barrels it lands on (#236).
 *
 * `import { ResponsivePopover } from '@/components/ui/popover'` names a barrel
 * that re-exports `default` from `ResponsivePopover.vue`; the file the importer
 * uses is that one, and an index that stopped at the barrel would answer
 * "nothing uses this component" for every component behind an `index.ts`. So
 * each name is followed, hop by hop, to every file it passes through, and the
 * importer gets an edge to each with the name as that file knows it:
 *
 * - `export { a as b } from` hands on `b` as `a`;
 * - `export * as ns from` hands on `ns` as `*`;
 * - `export * from` hands on a name only when that file exports it — never
 *   `default`, which a star re-export does not carry;
 * - a namespace import (`*`) of the barrel hands on everything it re-exports.
 *
 * A side-effect import hands on nothing. The importer keeps its edge to the
 * barrel itself. Returns a new map; `direct` is not changed.
 */
export function foldReexports(direct: ImportEdges, barrels: Map<string, Reexport[]>, ownExports: Map<string, string[]>): ImportEdges {
  const exportsMemo = new Map<string, Set<string>>();
  const exportsOf = (file: string): Set<string> => {
    const memo = exportsMemo.get(file);
    if (memo) return memo;
    const set = new Set<string>(ownExports.get(file) ?? []);
    // Set before recursing: a cycle of `export *` reads the partial set and ends.
    exportsMemo.set(file, set);
    for (const r of barrels.get(file) ?? []) {
      for (const name of Object.keys(r.names)) set.add(name);
      if (r.star) for (const name of exportsOf(r.target)) if (name !== 'default') set.add(name);
    }
    return set;
  };

  const out: ImportEdges = new Map([...direct].map(([importer, row]) => [importer, new Map([...row].map(([f, n]) => [f, new Set(n)]))]));
  for (const [importer, row] of direct) {
    const edges = out.get(importer)!;
    const queue: Array<[string, Set<string>]> = [...row];
    while (queue.length > 0) {
      const [barrel, names] = queue.pop()!;
      for (const r of barrels.get(barrel) ?? []) {
        if (r.target === importer) continue;
        const passed = new Set<string>();
        for (const name of names) {
          if (name === '*') {
            if (r.star) passed.add('*');
            for (const taken of Object.values(r.names)) passed.add(taken);
          } else if (Object.hasOwn(r.names, name)) {
            passed.add(r.names[name]);
          } else if (r.star && name !== 'default' && exportsOf(r.target).has(name)) {
            passed.add(name);
          }
        }
        const have = edges.get(r.target) ?? new Set<string>();
        const fresh = [...passed].filter((n) => !have.has(n));
        if (fresh.length === 0) continue;
        for (const name of fresh) have.add(name);
        edges.set(r.target, have);
        queue.push([r.target, new Set(fresh)]);
      }
    }
  }
  return out;
}

function readJson(files: Map<string, Uint8Array>, path: string, jsonc: boolean): Record<string, unknown> | null {
  const bytes = files.get(path);
  if (!bytes) return null;
  try {
    const text = Buffer.from(bytes).toString('utf8');
    const parsed: unknown = JSON.parse(jsonc ? stripJsonc(text) : text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `tsconfig` is JSON with comments and trailing commas. Strings are copied untouched. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `''` for a file at the root, never `'.'`. */
function dirOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
}

function repoPath(dir: string, relative: string): string {
  const joined = posix.normalize(posix.join(dir, relative));
  return joined === '.' ? '' : joined.replace(/^\.\//, '').replace(/\/$/, '');
}

/**
 * The files a flow reaches from its entry, breadth-first to `depth` hops:
 * relative imports resolved as files, and a bare import of a sibling module
 * resolved to that module's first entrypoint. What the Data flow page's version
 * hashes, and what the sequence prompt is shown the outlines of.
 */
export async function reachableFiles(
  entry: string,
  importsOf: (file: string) => Promise<string[]>,
  map: RepoMap,
  files: Map<string, Uint8Array>,
  depth: number,
  limit: number,
): Promise<string[]> {
  const byName = new Map<string, RepoModule>();
  for (const module of map.modules) if (module.manifest?.name) byName.set(module.manifest.name, module);

  const seen = new Set<string>([entry]);
  let frontier = [entry];
  for (let hop = 0; hop < depth && frontier.length > 0 && seen.size < limit; hop += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const specifier of await importsOf(file)) {
        const target = specifier.startsWith('.')
          ? resolveRelativeFile(file, specifier, files)
          : (matchByName(specifier, byName)?.entrypoints[0] ?? null);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        next.push(target);
        if (seen.size >= limit) break;
      }
    }
    frontier = next;
  }
  return [...seen];
}
