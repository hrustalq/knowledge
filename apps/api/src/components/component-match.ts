import { normalizeEntityKey } from '@knowledge/contracts';
import type { ComponentDeclarationWarning } from '@knowledge/contracts';
import type { ComponentFrontmatter } from '../common/frontmatter.js';
import { readFrontmatterRelations } from '../common/relations.js';

/**
 * The deterministic half of component pages (#236): which files a declaration
 * covers, which imports count as a use, which connector a declaration names,
 * and which pages document a usage site. No Nest, no I/O — the drift check
 * (phase 4) and the read side (phase 3) ask the same questions and must get
 * the same answers, so they are answered once, here.
 */

const GLOB = /[*?]/;

/** `**` crosses directories, `*` and `?` do not. */
function globRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      // `a/**/b` also matches `a/b`.
      const slash = pattern[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** A declared path covers a file when it is the file, a directory above it, or a glob matching it. */
export function pathCovers(pattern: string, file: string): boolean {
  if (GLOB.test(pattern)) return globRegExp(pattern).test(file);
  const dir = pattern.replace(/\/+$/, '');
  return file === dir || file.startsWith(`${dir}/`);
}

export function coversFile(paths: readonly string[], file: string): boolean {
  return paths.some((p) => pathCovers(p, file));
}

function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.indexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * Whether an import of `importedPath` taking `names` uses one of `symbols`.
 *
 * No symbols declared means any import counts. A namespace, star or lazy
 * import (`*`) may reach any export, so it counts. A default import counts for
 * a symbol named like the file: a `.vue` component has no export but its
 * default, and `ResponsivePopover` is how a page names `ResponsivePopover.vue`.
 * A side-effect import (no names) never uses a symbol.
 */
export function usesSymbols(symbols: readonly string[], names: readonly string[], importedPath: string): boolean {
  if (symbols.length === 0) return true;
  if (names.includes('*')) return true;
  if (names.some((n) => symbols.includes(n))) return true;
  return names.includes('default') && symbols.includes(baseName(importedPath));
}

/**
 * The entity a component page describes: `component.name`, else the page's own
 * `DESCRIBES component:*` relation (what the template writes), else its title.
 * Folded, so two spellings of one component are one vertex.
 */
export function componentKeyFor(
  block: ComponentFrontmatter,
  frontmatter: Record<string, unknown>,
  title: string,
): { key: string; name: string } {
  if (block.name) return { key: normalizeEntityKey(`component:${block.name}`), name: block.name };
  const described = readFrontmatterRelations(frontmatter).find(
    (r) => r.type === 'DESCRIBES' && r.target.key.startsWith('component:'),
  );
  if (described) return { key: described.target.key, name: described.target.name };
  return { key: normalizeEntityKey(`component:${title}`), name: title.trim() };
}

/**
 * A repository as lower-case segments, host first when there is one:
 * `https://github.com/Owner/Repo.git` and `github.com/owner/repo` both read
 * `github.com/owner/repo`, so either — or any tail of it — matches.
 */
export function repositorySegments(value: string): string[] {
  let path = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = `${url.host}${url.pathname}`;
    } catch {
      /* not a URL after all; read it as a path */
    }
  }
  return path
    .replace(/\.git$/i, '')
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface CodeConnectorRef {
  id: string;
  /** The connector's `repoUrl`. */
  repoUrl: string;
}

/**
 * Which connector a declaration names, or why none. A `repository` matches a
 * connector whose URL ends with it, so `repo`, `owner/repo` and the full URL
 * all work; two matches are as unusable as none, because guessing between them
 * is how a page would end up showing another repository's usages.
 */
export function resolveDeclaration(
  block: Pick<ComponentFrontmatter, 'repository' | 'paths'>,
  connectors: readonly CodeConnectorRef[],
): { connectorId: string | null; warning: ComponentDeclarationWarning | null } {
  if (block.paths.length === 0) return { connectorId: null, warning: 'no-paths' };
  if (connectors.length === 0) return { connectorId: null, warning: 'no-connector' };
  if (!block.repository) {
    return connectors.length === 1
      ? { connectorId: connectors[0].id, warning: null }
      : { connectorId: null, warning: 'ambiguous-repository' };
  }
  const wanted = repositorySegments(block.repository);
  const matches = connectors.filter((c) => {
    const have = repositorySegments(c.repoUrl);
    return wanted.length > 0 && wanted.length <= have.length && wanted.every((s, i) => have[have.length - wanted.length + i] === s);
  });
  if (matches.length === 1) return { connectorId: matches[0].id, warning: null };
  return { connectorId: null, warning: matches.length === 0 ? 'unknown-repository' : 'ambiguous-repository' };
}

export interface ResolvedDeclaration {
  documentId: string;
  componentKey: string;
  paths: string[];
  symbols: string[];
}

export interface ImportRow {
  importerPath: string;
  importedPath: string;
  names: string[];
}

/** Which component a page documents through which usage sites. */
export type ComponentUsageEdges = Map<string, Map<string, string[]>>;

/**
 * The pages that document `file`: the component pages whose paths cover it,
 * and only when there are none, the deepest wiki module page containing it.
 * A page that merely mentions the file never counts — a mention is a claim
 * about the text, not about the code.
 */
export function documentingPages(
  file: string,
  declarations: readonly ResolvedDeclaration[],
  modules: ReadonlyArray<{ dir: string; documentId: string }>,
): string[] {
  const pages = declarations.filter((d) => coversFile(d.paths, file)).map((d) => d.documentId);
  if (pages.length > 0) return [...new Set(pages)];
  let owner: { dir: string; documentId: string } | null = null;
  for (const m of modules) {
    const inside = m.dir === '' || file === m.dir || file.startsWith(`${m.dir}/`);
    if (inside && (!owner || m.dir.length > owner.dir.length)) owner = m;
  }
  return owner ? [owner.documentId] : [];
}

/**
 * For one connector: every page documenting a file that uses a declared
 * component, keyed page → component key → the usage files, sorted.
 *
 * An import from inside the component's own paths is the component using
 * itself, not a use of it. A page is never a dependent of the component it
 * declares.
 */
export function componentUsageEdges(
  declarations: readonly ResolvedDeclaration[],
  rows: readonly ImportRow[],
  modules: ReadonlyArray<{ dir: string; documentId: string }>,
): ComponentUsageEdges {
  const out: ComponentUsageEdges = new Map();
  const pagesOf = new Map<string, string[]>();
  for (const d of declarations) {
    for (const row of rows) {
      if (!coversFile(d.paths, row.importedPath) || coversFile(d.paths, row.importerPath)) continue;
      if (!usesSymbols(d.symbols, row.names, row.importedPath)) continue;
      let pages = pagesOf.get(row.importerPath);
      if (!pages) {
        pages = documentingPages(row.importerPath, declarations, modules);
        pagesOf.set(row.importerPath, pages);
      }
      for (const page of pages) {
        if (page === d.documentId) continue;
        const byKey = out.get(page) ?? new Map<string, string[]>();
        const files = byKey.get(d.componentKey) ?? [];
        if (!files.includes(row.importerPath)) files.push(row.importerPath);
        byKey.set(d.componentKey, files);
        out.set(page, byKey);
      }
    }
  }
  for (const byKey of out.values()) for (const files of byKey.values()) files.sort();
  return out;
}

/** Usage sites one answer lists by default, and at most; the rest are counted. */
export const DEFAULT_USAGE_LIMIT = 200;
export const MAX_USAGE_LIMIT = 1_000;

/** A usage site before pages are attached: the importing file and what it takes from the component. */
export interface UsageSite {
  path: string;
  imports: Array<{ path: string; names: string[] }>;
}

/**
 * The files that use the code under `paths`, in path order — the read-side
 * twin of `componentUsageEdges`, under the same two rules: an import from
 * inside `paths` is the component using itself, and with `symbols` declared
 * only an import taking one of them counts.
 */
export function usageSites(paths: readonly string[], symbols: readonly string[], rows: readonly ImportRow[]): UsageSite[] {
  const sites = new Map<string, UsageSite>();
  for (const row of rows) {
    if (!coversFile(paths, row.importedPath) || coversFile(paths, row.importerPath)) continue;
    if (!usesSymbols(symbols, row.names, row.importedPath)) continue;
    const site = sites.get(row.importerPath) ?? { path: row.importerPath, imports: [] };
    site.imports.push({ path: row.importedPath, names: row.names });
    sites.set(row.importerPath, site);
  }
  const out = [...sites.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const site of out) site.imports.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * `importedPath` filters narrowing the index read to rows `usageSites` can
 * keep: exact files and directory prefixes narrow it, a glob anywhere means
 * the whole index (null).
 */
export function importedPathPrefilter(paths: readonly string[]): Array<{ equals: string } | { startsWith: string }> | null {
  if (paths.some((p) => GLOB.test(p))) return null;
  return paths.flatMap((p) => {
    const dir = p.replace(/\/+$/, '');
    return [{ equals: dir }, { startsWith: `${dir}/` }];
  });
}

// ---- a pull request against the index (#236, phase 4) ------------------------

/** What the rules need of one changed file — `PullRequestFile` without the patch. */
export interface ChangedFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'modified' | 'removed' | 'renamed';
}

/** The changed files a declaration covers, by their path or the path they had. */
export function declaredChanges(paths: readonly string[], files: readonly ChangedFile[]): string[] {
  return files
    .filter((f) => coversFile(paths, f.path) || (f.previousPath !== null && coversFile(paths, f.previousPath)))
    .map((f) => f.path);
}

/**
 * The default-branch index as the pull request would leave it: the rows of
 * every `replaced` importer give way to what it imports at the head
 * (`overlay`), so a removed or moved-away importer imports nothing. Rows
 * importing a removed file stay — they are the usages the change breaks.
 */
export function overlayImports(base: readonly ImportRow[], overlay: readonly ImportRow[], replaced: Iterable<string>): ImportRow[] {
  const gone = new Set(replaced);
  return [...base.filter((r) => !gone.has(r.importerPath)), ...overlay];
}

/**
 * The `component.paths` edits a change makes necessary: a declared file it
 * removed or moved, and a declared directory every file of which it removed or
 * moved — to the one directory they all moved to, else gone. A glob is never
 * edited: it may match something new, and phase 6's health filter catches one
 * that matches nothing. `baseFiles` (the default branch's files) is what tells
 * a directory from a file; without it only exact files are fixed.
 */
export function declaredPathFixes(
  paths: readonly string[],
  files: readonly ChangedFile[],
  baseFiles: ReadonlySet<string> | null,
): Array<{ from: string; to: string | null }> {
  const gone = new Map<string, string | null>();
  for (const f of files) {
    if (f.status === 'removed') gone.set(f.path, null);
    else if (f.status === 'renamed' && f.previousPath) gone.set(f.previousPath, f.path);
  }
  const fixes: Array<{ from: string; to: string | null }> = [];
  for (const path of paths) {
    if (GLOB.test(path)) continue;
    if (gone.has(path)) {
      fixes.push({ from: path, to: gone.get(path) ?? null });
      continue;
    }
    if (!baseFiles) continue;
    const dir = path.replace(/\/+$/, '');
    const under = [...baseFiles].filter((f) => f.startsWith(`${dir}/`));
    if (under.length === 0 || under.some((f) => !gone.has(f))) continue;
    // `a/x.ts → b/x.ts` for every file means the directory moved to `b`.
    const targets = new Set(
      under.map((f) => {
        const to = gone.get(f);
        const rest = f.slice(dir.length);
        return to && to.endsWith(rest) && to.length > rest.length ? to.slice(0, to.length - rest.length) : null;
      }),
    );
    const [only] = targets;
    fixes.push({ from: path, to: targets.size === 1 && only ? only : null });
  }
  return fixes;
}

/** `paths` with `fixes` applied, moves in place and removals dropped. */
export function applyPathFixes(paths: readonly string[], fixes: ReadonlyArray<{ from: string; to: string | null }>): string[] {
  const byFrom = new Map(fixes.map((f) => [f.from, f.to]));
  const out: string[] = [];
  for (const path of paths) {
    const next = byFrom.has(path) ? byFrom.get(path) : path;
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}

/** The names a module's front door goes by: its directory names it instead. */
const ENTRY_BASENAMES = new Set(['index', 'main', 'mod', 'lib', '__init__', '__main__']);

/**
 * The name a component page gets when "Document this component" is not told
 * one (#236, phase 5): the file's base name, or its directory's for an entry
 * file — `ResponsivePopover.vue` is `ResponsivePopover`, `billing/index.ts`
 * is `billing`. Spelled as the code spells it; the entity key folds it.
 */
export function componentNameFor(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const file = parts.pop() ?? path;
  const base = file.replace(/\.[^.]+$/, '');
  return (ENTRY_BASENAMES.has(base.toLowerCase()) && parts.length ? parts.pop()! : base) || file;
}

/**
 * A path "Document this component" can read, or null: one repo-relative file,
 * never a glob, a directory or a walk out of the repository — a draft is
 * written from files the run opens, and the declaration it writes must name
 * exactly those.
 */
export function draftablePath(raw: string): string | null {
  const path = raw.trim().replace(/^(\.\/)+|^\/+/, '');
  if (!path || path.endsWith('/') || /[*?[\]{}]/.test(path)) return null;
  if (path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return null;
  return path;
}
