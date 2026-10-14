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

const ECMA_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/**
 * The file a relative ECMAScript import names, or null. NodeNext writes `./x.js`
 * for a sibling `x.ts`, and bundlers allow the extension and `/index` to be
 * left off, so each of those spellings is tried against the archive.
 */
export function resolveRelativeFile(fromFile: string, specifier: string, files: Map<string, Uint8Array>): string | null {
  if (!specifier.startsWith('.') || !ECMA_FILE.test(fromFile)) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const stem = base.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  const candidates = [
    base,
    ...ECMA_EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...ECMA_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((c) => files.has(c)) ?? null;
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
