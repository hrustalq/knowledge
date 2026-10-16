import { extractExportNames, extractImports, type ImportRef } from './code-symbols.js';
import type { CodeImportEdge } from './connector.types.js';
import { foldReexports, type FileResolver, type ImportEdges, type Reexport } from './import-resolver.js';
import type { CodeLanguage, TreeSitterService } from './tree-sitter.service.js';

/**
 * Importer → imported file edges for some of a repository's files (#236).
 *
 * One routine for the two readers of it: the codebase pull indexes every file
 * at the head, and the drift check re-reads only the files a pull request
 * changed, on top of that index. Both must agree on what an import resolves to
 * and how a barrel passes names on, or a usage the pull adds would read
 * differently from the same usage after it merged.
 */

/** Single-file components: tree-sitter has no grammar for them, so their `<script>` blocks are parsed. */
export const SFC_FILE = /\.(?:vue|svelte)$/;
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** What the edges need of one file: what it imports, and what it exports. */
export interface ImportOutline {
  imports: ImportRef[];
  exports: string[];
}

/** `undefined` = not source, `null` = unparseable. */
export type ImportOutlineReader = (path: string) => Promise<ImportOutline | null | undefined>;

/** Files read past the asked importers, only to follow their barrels. */
const MAX_BARREL_READS = 500;

/**
 * A `.vue` / `.svelte` file's imports, from its `<script>` blocks
 * (`lang="ts"` parsed as TypeScript). The component itself is its default
 * export, whether or not a block says so.
 */
export async function sfcOutline(treeSitter: Pick<TreeSitterService, 'withTree'>, bytes: Uint8Array | undefined): Promise<ImportOutline> {
  const outline: ImportOutline = { imports: [], exports: ['default'] };
  if (!bytes) return outline;
  for (const [, attrs, body] of Buffer.from(bytes).toString('utf8').matchAll(SCRIPT_BLOCK)) {
    const lang = /\blang\s*=\s*["']?(\w+)/.exec(attrs)?.[1];
    const language: CodeLanguage = lang === 'tsx' ? 'tsx' : lang === 'ts' ? 'typescript' : 'javascript';
    const read = await treeSitter.withTree(language, body, (tree) => ({
      imports: extractImports(language, tree),
      exports: extractExportNames(language, tree),
    }));
    if (!read) continue;
    outline.imports.push(...read.imports);
    for (const name of read.exports) if (!outline.exports.includes(name)) outline.exports.push(name);
  }
  return outline;
}

/** One file's imports and exports, from bytes in hand. */
export async function importOutline(
  treeSitter: Pick<TreeSitterService, 'withTree' | 'languageForPath'>,
  path: string,
  files: Map<string, Uint8Array>,
): Promise<ImportOutline | null | undefined> {
  if (SFC_FILE.test(path)) return sfcOutline(treeSitter, files.get(path));
  const language = treeSitter.languageForPath(path);
  const bytes = files.get(path);
  if (!language || !bytes) return undefined;
  return treeSitter.withTree(language, Buffer.from(bytes).toString('utf8'), (tree) => ({
    imports: extractImports(language, tree),
    exports: extractExportNames(language, tree),
  }));
}

/**
 * The files one import lands on, with the names it takes there. One import is
 * one target, except Python's `from . import a, b`, where each name may be a
 * sibling module (`a.py`) rather than something the package's `__init__.py`
 * defines — so each is tried as a module first.
 */
export function importTargets(resolve: FileResolver, importer: string, ref: ImportRef): Array<[string, string[]]> {
  if (/\.pyi?$/.test(importer) && /^\.+$/.test(ref.specifier)) {
    const out: Array<[string, string[]]> = [];
    const rest: string[] = [];
    for (const name of ref.names) {
      const module = name === '*' ? null : resolve(importer, `${ref.specifier}${name}`);
      if (module) out.push([module, ['*']]);
      else rest.push(name);
    }
    const init = rest.length > 0 || ref.names.length === 0 ? resolve(importer, ref.specifier) : null;
    if (init) out.push([init, rest]);
    return out;
  }
  const target = resolve(importer, ref.specifier);
  return target ? [[target, ref.names]] : [];
}

/**
 * The edges of `importers`, carried through the barrels they land on
 * (`foldReexports`). A barrel outside `importers` is read only for its
 * re-exports and exports — it gains no edges of its own — so a caller asking
 * about three files pays for three files and the barrels between them, not
 * the repository.
 */
export async function collectImportEdges(
  importers: Iterable<string>,
  resolve: FileResolver,
  outlineOf: ImportOutlineReader,
): Promise<{ edges: CodeImportEdge[]; barrels: number }> {
  const direct: ImportEdges = new Map();
  const barrels = new Map<string, Reexport[]>();
  const ownExports = new Map<string, string[]>();
  const read = new Set<string>();
  const pending: string[] = [];

  const visit = async (file: string, asImporter: boolean): Promise<void> => {
    read.add(file);
    const outline = await outlineOf(file);
    if (!outline) return;
    if (outline.exports.length > 0) ownExports.set(file, outline.exports);
    const row = new Map<string, Set<string>>();
    for (const ref of outline.imports) {
      if (!asImporter && !ref.reexport) continue;
      for (const [target, names] of importTargets(resolve, file, ref)) {
        if (target === file) continue;
        if (ref.reexport) barrels.set(file, [...(barrels.get(file) ?? []), { target, ...ref.reexport }]);
        if (!read.has(target)) pending.push(target);
        if (!asImporter) continue;
        const set = row.get(target) ?? new Set<string>();
        for (const name of names) set.add(name);
        row.set(target, set);
      }
    }
    if (row.size > 0) direct.set(file, row);
  };

  for (const importer of importers) await visit(importer, true);
  let extra = 0;
  while (pending.length > 0 && extra < MAX_BARREL_READS) {
    const file = pending.pop()!;
    if (read.has(file)) continue;
    extra += 1;
    await visit(file, false);
  }

  const edges: CodeImportEdge[] = [];
  for (const [importer, row] of foldReexports(direct, barrels, ownExports)) {
    for (const [imported, names] of row) edges.push({ importer, imported, names: [...names].sort() });
  }
  return { edges, barrels: barrels.size };
}
