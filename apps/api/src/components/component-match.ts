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
