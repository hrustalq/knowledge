import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Tree } from 'web-tree-sitter';

/**
 * tree-sitter, loaded lazily (docs/features/27).
 *
 * ## Why the WASM binding and not the native one
 *
 * `tree-sitter` proper declares `"install": "node-gyp-build"`, and pnpm 10
 * blocks dependency build scripts unless a package is listed in
 * `pnpm-workspace.yaml`'s `onlyBuiltDependencies` — so the native route would
 * install *silently unbuilt* and fail at first parse. It would also need
 * python3/make/g++ in `Dockerfile.api`, whose base stage carries only openssl
 * and ca-certificates, on a box that already caps the builder at 2560 MB
 * because two concurrent `tsc` runs can exhaust it. `web-tree-sitter` is the
 * same parser and the same grammars, compiled to wasm, with no toolchain.
 *
 * Grammars come from `@vscode/tree-sitter-wasm`, which ships them prebuilt and
 * is the set VS Code itself ships. They are built against ABI 14/15 and load
 * into the 0.27 runtime unchanged — verified before this was written, because a
 * grammar/runtime ABI mismatch fails at `Language.load` and nowhere earlier.
 *
 * ## Why nothing happens in the constructor
 *
 * `scripts/generate-openapi.main.ts` calls `NestFactory.create(AppModule)`,
 * which constructs every provider in the graph — including this one, since
 * `ConnectorAdaptersModule` is reachable from `AppModule` — but never calls
 * `.init()`, so lifecycle hooks never run there. A constructor that compiled
 * wasm would put a hundred milliseconds and 12 MB into a script whose whole
 * point is to emit a schema with no infrastructure; an `onModuleInit` would run
 * in the worker and the MCP server but not there, which is worse, because then
 * the timing differs per entrypoint. Lazy-on-first-parse is the only shape that
 * is identical in all four.
 */

/** The languages we can read. Adding one is an entry here plus an extension below. */
export const CODE_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'ruby',
  'php',
  'c-sharp',
  'cpp',
  'bash',
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

const BY_EXTENSION: Record<string, CodeLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  cs: 'c-sharp',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  h: 'cpp',
  sh: 'bash',
  bash: 'bash',
};

/**
 * Above this, a file is treated as opaque rather than parsed.
 *
 * `repo-archive` already refuses anything over 1 MB, so this only catches the
 * band between: a generated client, a bundled vendor file, a fixture. The
 * largest hand-written file in this repository is 48 KB, so 512 KB is far above
 * anything a person wrote and far below anything that would hurt.
 */
const MAX_PARSE_BYTES = 512_000;

@Injectable()
export class TreeSitterService {
  private readonly logger = new Logger(TreeSitterService.name);

  /** The promise, not the result: two concurrent first-parses must not both init. */
  private runtime: Promise<void> | null = null;
  private readonly languages = new Map<CodeLanguage, Promise<Language | null>>();
  private parser: Parser | null = null;

  /** Null when we have no grammar for this path — the caller skips the file. */
  languageForPath(path: string): CodeLanguage | null {
    return languageForPath(path);
  }

  /**
   * Parse `source`, hand the tree to `read`, and free it afterwards — always.
   *
   * The tree is never returned. `Tree` holds memory in the Emscripten heap that
   * V8 cannot collect (it only ever sees the wrapper object), so a tree that
   * escapes is a leak in a worker process that runs for weeks. Handing out a
   * callback instead of a tree makes that unrepresentable rather than merely
   * discouraged.
   *
   * Returns null — never throws — when the language is unsupported, the grammar
   * failed to load, the file is too big, or the parse itself blew up. A single
   * unreadable file must not abort a sync: `list()` and `fetch()` are async
   * iterables, and an uncaught throw there takes down every other file with it.
   */
  async withTree<T>(language: CodeLanguage, source: string, read: (tree: Tree) => T): Promise<T | null> {
    if (source.length > MAX_PARSE_BYTES) return null;

    const grammar = await this.languageFor(language);
    if (!grammar) return null;
    await this.ensureRuntime();

    let tree: Tree | null = null;
    try {
      // One parser, reused with `setLanguage` per file: constructing one per
      // file reserves wasm memory every time for no benefit.
      //
      // `setLanguage` and `parse` MUST stay in one synchronous block with no
      // await between them. This used to be split across an async helper, which
      // was safe only while the sole caller was the sync pipeline at BullMQ
      // concurrency 1. The code research tools (docs/features/31) parse from the
      // API process, where two `code_outline` calls in one round run
      // concurrently — an await boundary between the two calls would let the
      // second caller's `setLanguage` land before the first caller's `parse`,
      // and a TypeScript file would be read with the Python grammar.
      this.parser ??= new Parser();
      this.parser.setLanguage(grammar);
      tree = this.parser.parse(source);
      return tree ? read(tree) : null;
    } catch (err) {
      this.logger.debug(`parse failed (${language}): ${(err as Error).message}`);
      return null;
    } finally {
      tree?.delete();
    }
  }

  // --- internals ---

  private ensureRuntime(): Promise<void> {
    this.runtime ??= Parser.init({
      // Emscripten asks for the runtime wasm by name; the package exports that
      // exact subpath, so resolution goes through Node's own algorithm and works
      // identically from `src` under nest --watch, from `dist`, and in the image.
      locateFile: () => resolvePackageFile('web-tree-sitter/web-tree-sitter.wasm'),
    });
    return this.runtime;
  }

  private languageFor(language: CodeLanguage): Promise<Language | null> {
    let loading = this.languages.get(language);
    if (!loading) {
      loading = this.loadLanguage(language);
      this.languages.set(language, loading);
    }
    return loading;
  }

  private async loadLanguage(language: CodeLanguage): Promise<Language | null> {
    try {
      await this.ensureRuntime();
      const bytes = await readFile(resolvePackageFile(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${language}.wasm`));
      const grammar = await Language.load(bytes);
      this.logger.log(`grammar loaded: ${language} (abi ${grammar.abiVersion})`);
      return grammar;
    } catch (err) {
      // Cached as null, so a missing grammar is one log line per process rather
      // than one per file in a repository full of that language.
      this.logger.warn(`grammar unavailable: ${language} — ${(err as Error).message}`);
      return null;
    }
  }
}

/**
 * Which grammar reads this path, or null for "not source we can read".
 *
 * A free function as well as a method because the repository mapper needs the
 * same answer while deciding what counts as a source file, and it is a pure
 * table lookup — making it reach for an injected service to ask would be
 * ceremony around a `Record` access.
 */
export function languageForPath(path: string): CodeLanguage | null {
  const ext = path.split('.').pop()?.toLowerCase();
  return (ext && BY_EXTENSION[ext]) || null;
}

/** `import.meta.resolve` is ESM's `require.resolve`; there is no __dirname here. */
function resolvePackageFile(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}
