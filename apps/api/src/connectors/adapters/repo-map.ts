import { createHash } from 'node:crypto';
import { languageForPath } from './tree-sitter.service.js';

/**
 * The shape of a repository, worked out from its file listing (docs/features/27).
 *
 * Pure and synchronous on purpose: everything here is decided from paths and
 * manifest files, with no parsing and no model. That keeps the expensive halves
 * — tree-sitter in `code-symbols.ts`, the narration in the adapter — downstream
 * of a structure that can be reasoned about, and it is what lets a module's
 * identity be computed before deciding whether to spend anything on it.
 */

/** The hub page's identity. Stable forever: it is a `connector_links` key. */
export const OVERVIEW_KEY = 'overview';

/**
 * Bumping this re-derives every page on the next sync.
 *
 * The version hash of a unit mixes this in, so an improvement to extraction or
 * to the prompt reaches repositories that have already been synced — which is
 * otherwise impossible, because their source has not changed and every unit
 * would skip.
 */
export const GENERATOR_VERSION = '1';

export type ManifestKind = 'npm' | 'go' | 'python' | 'rust' | 'java' | 'php' | 'ruby';

/** Manifest filename -> ecosystem. Presence of one is what makes a directory a module. */
const MANIFESTS: Record<string, ManifestKind> = {
  'package.json': 'npm',
  'go.mod': 'go',
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'Cargo.toml': 'rust',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'java',
  'composer.json': 'php',
  Gemfile: 'ruby',
};

/** Conventional entrypoint filenames, checked against a module's own files. */
const ENTRYPOINT_NAMES = new Set([
  'main.go',
  '__main__.py',
  'main.py',
  'main.rs',
  'lib.rs',
  'main.ts',
  'main.js',
  'index.ts',
  'index.js',
  'app.ts',
  'server.ts',
]);

export interface RepoManifest {
  kind: ManifestKind;
  path: string;
  name?: string;
  description?: string;
  /** Declared dependencies, names only — what this module rests on. */
  dependencies: string[];
}

export interface RepoModule {
  /** `module:<path>` — the identity map key, and therefore permanent. */
  key: string;
  /** Repo-relative directory. Empty string means the repository root itself. */
  path: string;
  name: string;
  manifest: RepoManifest | null;
  /** Source files assigned to this module, deepest-root-wins. */
  files: string[];
  bytes: number;
  entrypoints: string[];
}

export interface RepoMap {
  modules: RepoModule[];
  /** Modules that existed but did not fit under the configured limit. */
  omitted: number;
  rootManifest: RepoManifest | null;
  readmePath: string | null;
  /** Every path that describes the project as a whole, for the hub page's hash. */
  overviewPaths: string[];
  sourceFileCount: number;
  totalBytes: number;
  /** Source file counts per language, largest first — the "what is this written in" line. */
  languages: Array<{ language: string; files: number }>;
}

export function moduleKey(path: string): string {
  return `module:${path}`;
}

export function buildRepoMap(
  files: Map<string, Uint8Array>,
  options: { subdir: string; maxModules: number },
): RepoMap {
  const { subdir, maxModules } = options;
  const inScope = (path: string): boolean => !subdir || path === subdir || path.startsWith(`${subdir}/`);

  // --- what is source, and what is a manifest ---
  const sourceFiles: string[] = [];
  const languageCounts = new Map<string, number>();
  const manifests: RepoManifest[] = [];
  let readmePath: string | null = null;

  for (const [path, bytes] of files) {
    const base = path.split('/').pop() ?? path;

    if (MANIFESTS[base] && inScope(path)) {
      manifests.push(readManifest(MANIFESTS[base], path, bytes));
    }
    if (!readmePath && /^readme\.mdx?$/i.test(base) && path.split('/').length <= 2) {
      readmePath = path;
    }
    if (!inScope(path)) continue;

    const language = languageForPath(path);
    if (!language) continue;
    sourceFiles.push(path);
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }

  // --- module roots ---
  // A directory holding a manifest is a module. Failing that (a repository that
  // is just a folder of code), the first level below `subdir` is, because that
  // is the only structure such a repository actually declares.
  const manifestRoots = manifests.map((m) => dirOf(m.path));
  const roots = manifestRoots.length > 0 ? new Set(manifestRoots) : new Set(firstLevelDirs(sourceFiles, subdir));
  if (roots.size === 0) roots.add(subdir);

  const byRoot = new Map<string, { files: string[]; bytes: number }>();
  for (const root of roots) byRoot.set(root, { files: [], bytes: 0 });

  for (const path of sourceFiles) {
    // Deepest root wins, so a monorepo's own package.json keeps only the files
    // that belong to no workspace rather than swallowing all of them.
    const root = deepestRoot(path, roots);
    if (root === null) continue;
    const bucket = byRoot.get(root);
    if (!bucket) continue;
    bucket.files.push(path);
    bucket.bytes += files.get(path)?.length ?? 0;
  }

  const manifestByDir = new Map(manifests.map((m) => [dirOf(m.path), m]));
  const all: RepoModule[] = [];
  for (const [root, bucket] of byRoot) {
    if (bucket.files.length === 0) continue;
    const manifest = manifestByDir.get(root) ?? null;
    all.push({
      key: moduleKey(root),
      path: root,
      name: manifest?.name || root.split('/').filter(Boolean).pop() || 'root',
      manifest,
      files: bucket.files.sort(),
      bytes: bucket.bytes,
      entrypoints: bucket.files.filter((f) => ENTRYPOINT_NAMES.has(f.split('/').pop() ?? '')),
    });
  }

  // Largest first: if a limit has to bite, it should bite the least of the code.
  all.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  const modules = all.slice(0, Math.max(1, maxModules));

  const rootManifest = manifestByDir.get(subdir) ?? manifestByDir.get('') ?? null;
  const overviewPaths = [
    ...manifests.map((m) => m.path),
    ...(readmePath ? [readmePath] : []),
    // The module list itself: adding or removing a module changes the hub even
    // when no manifest did.
    ...modules.map((m) => m.path),
  ].sort();

  return {
    modules,
    omitted: all.length - modules.length,
    rootManifest,
    readmePath,
    overviewPaths,
    sourceFileCount: sourceFiles.length,
    totalBytes: sourceFiles.reduce((sum, p) => sum + (files.get(p)?.length ?? 0), 0),
    languages: [...languageCounts.entries()]
      .map(([language, count]) => ({ language, files: count }))
      .sort((a, b) => b.files - a.files),
  };
}

/**
 * The version of a unit: what went into it, not when it was made.
 *
 * `stage()` compares this against the link's stored version and skips before
 * fetching anything when they match, so this hash is the whole reason a re-sync
 * of an unchanged repository costs no model calls. It therefore has to cover
 * every input that can change the page — the files, and the generator itself.
 */
export function unitInputHash(files: Map<string, Uint8Array>, paths: string[], extra: string[] = []): string {
  const hash = createHash('sha256');
  hash.update(`v${GENERATOR_VERSION}\n`);
  for (const extraPart of extra) hash.update(`${extraPart}\n`);
  for (const path of [...paths].sort()) {
    const bytes = files.get(path);
    // A path that vanished still contributes: its absence must change the hash.
    hash.update(path);
    hash.update(bytes ? createHash('sha256').update(bytes).digest() : 'missing');
  }
  return hash.digest('hex').slice(0, 16);
}

// --- helpers ---

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function firstLevelDirs(paths: string[], subdir: string): string[] {
  const prefix = subdir ? `${subdir}/` : '';
  const dirs = new Set<string>();
  for (const path of paths) {
    const rest = path.slice(prefix.length);
    const cut = rest.indexOf('/');
    dirs.add(cut === -1 ? subdir : `${prefix}${rest.slice(0, cut)}`);
  }
  return [...dirs];
}

function deepestRoot(path: string, roots: Set<string>): string | null {
  let best: string | null = null;
  for (const root of roots) {
    const matches = root === '' || path === root || path.startsWith(`${root}/`);
    if (matches && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

/**
 * Manifests are read for the few fields a reader wants — who this is and what it
 * depends on — and otherwise left alone. `package.json` is JSON; the rest are
 * scraped with one narrow regex each, because pulling in a TOML, an XML and a
 * Gradle parser to read a name and a description would be three dependencies for
 * three lines of text.
 */
function readManifest(kind: ManifestKind, path: string, bytes: Uint8Array): RepoManifest {
  const text = Buffer.from(bytes).toString('utf8');
  const manifest: RepoManifest = { kind, path, dependencies: [] };

  if (kind === 'npm' || kind === 'php') {
    try {
      const json = JSON.parse(text) as {
        name?: string;
        description?: string;
        dependencies?: Record<string, string>;
        require?: Record<string, string>;
      };
      manifest.name = json.name;
      manifest.description = json.description;
      manifest.dependencies = Object.keys(json.dependencies ?? json.require ?? {});
    } catch {
      // A manifest we cannot read still marks a module root, which is the only
      // thing this function is load-bearing for.
    }
    return manifest;
  }

  const name =
    /^module\s+(\S+)/m.exec(text)?.[1] ?? // go.mod
    /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? // Cargo.toml, pyproject
    /<artifactId>([^<]+)<\/artifactId>/.exec(text)?.[1]; // pom.xml
  if (name) manifest.name = name;

  const description = /^\s*description\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  if (description) manifest.description = description;

  return manifest;
}
