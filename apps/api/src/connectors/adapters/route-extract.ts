import type { Node, Tree } from 'web-tree-sitter';
import type { CodeLanguage, TreeSitterService } from './tree-sitter.service.js';

/**
 * The HTTP routes a repository declares, read off its syntax trees (#78,
 * phase 8) — the code side of the spec ↔ code drift check.
 *
 * Deterministic and Nest-free. Four families, each read the way its framework
 * spells a route, and nothing else:
 *
 * - **NestJS**: `@Controller(path)` on a class, `@Get(path)`… (and `@Sse`) on
 *   its methods, and `app.setGlobalPrefix(path)` wherever the app is
 *   bootstrapped. `@ApiExcludeController()` / `@ApiExcludeEndpoint()` say the
 *   route is deliberately not in the spec, so it is not read.
 * - **Express / Fastify / Hono / Koa router**: `x.get('/path', handler)` and
 *   `x.route('/path').get(handler)`, only in a file that imports one of them —
 *   `config.get('/x', fallback)` and `axios.get('/users', opts)` have the same
 *   shape, and a file that never imported a router is not declaring one.
 * - **FastAPI**: `@x.get("/path")` decorators, with an `APIRouter(prefix=…)`
 *   bound to a name in the same file, in a file that imports fastapi;
 *   `include_in_schema=False` is skipped for the same reason.
 * - **Go**: `net/http` `HandleFunc`/`Handle` (with Go 1.22 `"GET /path"`
 *   patterns and gorilla's `.Methods(…)`), chi's `r.Get` + `r.Route` closures,
 *   and gin/echo/fiber `r.GET` + `x.Group(prefix)`.
 *
 * A path that is not a literal — a constant, a template with a substitution —
 * is counted as `dynamic` and dropped, never guessed. Anything else is simply
 * not a route here; the comparator reads "no routes at all" as "this framework
 * is not supported", not as "every operation is missing".
 */

export const ROUTE_FRAMEWORKS = ['nestjs', 'express', 'fastapi', 'go'] as const;
export type RouteFramework = (typeof ROUTE_FRAMEWORKS)[number];

export interface DeclaredRoute {
  /** Upper case; `*` where the route answers any method (`@All`, `.all`, a bare `HandleFunc`). */
  method: string;
  /** As written, prefixes applied: `/users/:id`, `/items/{id}`. */
  path: string;
  file: string;
  line: number;
  framework: RouteFramework;
}

export interface FileRoutes {
  routes: DeclaredRoute[];
  /** `app.setGlobalPrefix(...)` values seen in the file (NestJS). */
  globalPrefixes: string[];
  /** Route declarations whose path was not a literal, so were not read. */
  dynamic: number;
}

const ROUTE_LANGUAGES: ReadonlySet<CodeLanguage> = new Set(['typescript', 'tsx', 'javascript', 'python', 'go']);

/**
 * A cheap gate before a parse: a repository has thousands of source files and
 * a few dozen route files. A false positive costs one parse; a false negative
 * would hide a route, so this only has to be loose.
 */
const ROUTE_HINT =
  /@(?:Controller|Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(|setGlobalPrefix|\.(?:get|post|put|patch|delete|options|head|all|route)\s*\(|\.(?:Handle|HandleFunc|Get|Post|Put|Patch|Delete|Options|Head|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Route|Group)\s*\(/;

const ECMA_ROUTER_IMPORT = /(?:\bfrom\s*|\brequire\s*\(\s*)['"](?:express|fastify|hono|@koa\/router|koa-router)['"]/;
const FASTAPI_IMPORT = /^\s*(?:from\s+fastapi\b|import\s+fastapi\b)/m;
const GO_ROUTER_IMPORT = /"(?:net\/http|github\.com\/go-chi\/chi[^"]*|github\.com\/gin-gonic\/gin|github\.com\/labstack\/echo[^"]*|github\.com\/gorilla\/mux|github\.com\/gofiber\/fiber[^"]*)"/;

const NEST_METHODS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Options: 'OPTIONS',
  Head: 'HEAD',
  All: '*',
  // Server-sent events: a GET that streams.
  Sse: 'GET',
};
const LOWER_METHODS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  options: 'OPTIONS',
  head: 'HEAD',
  all: '*',
};
/** chi and fiber spell methods `Get`, gin and echo `GET`; both families say `Any`/`All`. */
const GO_METHODS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Options: 'OPTIONS',
  Head: 'HEAD',
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  OPTIONS: 'OPTIONS',
  HEAD: 'HEAD',
  Any: '*',
  All: '*',
};
const GO_HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|CONNECT|TRACE)\s+(\/.*)$/;

/** Whether a file in this language could declare a route — before its text is known. */
export function isRouteLanguage(language: CodeLanguage | null): boolean {
  return !!language && ROUTE_LANGUAGES.has(language);
}

/** Whether a file is worth a parse for routes at all. */
export function mayDeclareRoutes(language: CodeLanguage | null, text: string): boolean {
  return isRouteLanguage(language) && ROUTE_HINT.test(text);
}

/** One file's routes, from bytes in hand; null when the file is not read for routes. */
export async function fileRoutes(
  treeSitter: Pick<TreeSitterService, 'withTree' | 'languageForPath'>,
  path: string,
  text: string,
): Promise<FileRoutes | null> {
  const language = treeSitter.languageForPath(path);
  if (!mayDeclareRoutes(language, text)) return null;
  return treeSitter.withTree(language!, text, (tree) => extractRoutes(language!, tree, path, text));
}

export function extractRoutes(language: CodeLanguage, tree: Tree, file: string, text: string): FileRoutes {
  const out: FileRoutes = { routes: [], globalPrefixes: [], dynamic: 0 };
  if (language === 'python') {
    if (FASTAPI_IMPORT.test(text)) readFastApi(tree.rootNode, file, out);
  } else if (language === 'go') {
    if (GO_ROUTER_IMPORT.test(text)) readGo(tree.rootNode, file, out);
  } else {
    readNest(tree.rootNode, file, out);
    if (ECMA_ROUTER_IMPORT.test(text)) readEcmaRouters(tree.rootNode, file, out);
  }
  return out;
}

/** `a` + `b` as one URL path: one slash between, none doubled, none trailing (but `/` stays `/`). */
export function joinRoutePath(...parts: string[]): string {
  const joined = parts
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

// ---------------------------------------------------------------------------
// NestJS
// ---------------------------------------------------------------------------

function readNest(root: Node, file: string, out: FileRoutes): void {
  for (const call of root.descendantsOfType('call_expression')) {
    if (!call) continue;
    const fn = call.childForFieldName('function');
    if (fn?.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 'setGlobalPrefix') continue;
    const prefix = ecmaStrings(firstArgument(call));
    if (prefix?.length === 1) out.globalPrefixes.push(prefix[0]);
  }

  for (const cls of root.descendantsOfType(['class_declaration', 'abstract_class_declaration'])) {
    if (!cls) continue;
    // `@Controller() export class X` hangs the decorator on the export statement.
    const decorators = [...cls.namedChildren, ...(cls.parent?.type === 'export_statement' ? cls.parent.namedChildren : [])].filter(
      (n): n is Node => n?.type === 'decorator',
    );
    const calls = decorators.map(decoratorCall);
    const controller = calls.find((d) => d?.name === 'Controller');
    if (!controller || calls.some((d) => d?.name === 'ApiExcludeController')) continue;
    const bases = controllerPaths(controller.args);
    if (!bases) {
      out.dynamic += 1;
      continue;
    }

    const body = cls.childForFieldName('body');
    let pending: Node[] = [];
    for (const member of body?.namedChildren ?? []) {
      // A comment between two decorators (`@Get()` / `// why` / `@Access(…)`) is not the end of them.
      if (!member || member.type === 'comment') continue;
      if (member.type === 'decorator') {
        pending.push(member);
        continue;
      }
      if (member.type === 'method_definition') {
        const own = [...pending, ...member.namedChildren.filter((n): n is Node => n?.type === 'decorator')];
        if (own.some((d) => decoratorCall(d)?.name === 'ApiExcludeEndpoint')) {
          pending = [];
          continue;
        }
        for (const d of own) {
          const call = decoratorCall(d);
          const method = call && NEST_METHODS[call.name];
          if (!method) continue;
          const paths = call.args ? ecmaStrings(call.args) : [''];
          if (!paths) {
            out.dynamic += 1;
            continue;
          }
          for (const base of bases) {
            for (const path of paths) out.routes.push(route(method, joinRoutePath(base, path), file, d, 'nestjs'));
          }
        }
      }
      pending = [];
    }
  }
}

/** `@Name(arg)` → its name and first argument (null when called with none); null when not a call. */
function decoratorCall(decorator: Node): { name: string; args: Node | null } | null {
  const call = decorator.namedChildren.find((n) => n?.type === 'call_expression');
  const fn = call?.childForFieldName('function');
  if (!call || fn?.type !== 'identifier') return null;
  return { name: fn.text, args: firstArgument(call) };
}

/** `@Controller('a')`, `@Controller(['a', 'b'])`, `@Controller({ path: 'a' })`, `@Controller()`. */
function controllerPaths(arg: Node | null): string[] | null {
  if (!arg) return [''];
  if (arg.type === 'object') {
    const pair = arg.namedChildren.find((p) => p?.type === 'pair' && p.childForFieldName('key')?.text === 'path');
    const value = pair?.childForFieldName('value');
    return value ? ecmaStrings(value) : [''];
  }
  return ecmaStrings(arg);
}

// ---------------------------------------------------------------------------
// Express, Fastify, Hono, Koa router
// ---------------------------------------------------------------------------

function readEcmaRouters(root: Node, file: string, out: FileRoutes): void {
  for (const call of root.descendantsOfType('call_expression')) {
    if (!call) continue;
    const fn = call.childForFieldName('function');
    if (fn?.type !== 'member_expression') continue;
    const method = LOWER_METHODS[fn.childForFieldName('property')?.text ?? ''];
    if (!method) continue;
    const args = argumentNodes(call);
    const first = args[0];

    // `router.get('/x', handler)` — a path and at least one handler.
    if (first && args.length >= 2 && isEcmaStringLike(first)) {
      const path = ecmaStrings(first);
      if (!path) {
        out.dynamic += 1;
        continue;
      }
      if (path.length === 1 && path[0].startsWith('/')) out.routes.push(route(method, path[0], file, call, 'express'));
      continue;
    }
    // `router.route('/x').get(h).post(h)` — the path is down the chain.
    const path = chainedRoutePath(fn.childForFieldName('object'));
    if (path) out.routes.push(route(method, path, file, call, 'express'));
  }
}

function chainedRoutePath(node: Node | null): string | null {
  let current = node;
  while (current?.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (fn?.type !== 'member_expression') return null;
    if (fn.childForFieldName('property')?.text === 'route') {
      const path = ecmaStrings(firstArgument(current));
      return path?.length === 1 && path[0].startsWith('/') ? path[0] : null;
    }
    current = fn.childForFieldName('object');
  }
  return null;
}

// ---------------------------------------------------------------------------
// FastAPI
// ---------------------------------------------------------------------------

function readFastApi(root: Node, file: string, out: FileRoutes): void {
  // `router = APIRouter(prefix="/items")` — the prefix every `@router.x` route gets.
  const prefixes = new Map<string, string>();
  for (const assignment of root.descendantsOfType('assignment')) {
    const left = assignment?.childForFieldName('left');
    const right = assignment?.childForFieldName('right');
    if (left?.type !== 'identifier' || right?.type !== 'call' || right.childForFieldName('function')?.text !== 'APIRouter') continue;
    const prefix = keywordArgument(right, 'prefix');
    const value = prefix ? pythonString(prefix) : null;
    if (value !== null) prefixes.set(left.text, value);
  }

  for (const decorator of root.descendantsOfType('decorator')) {
    const call = decorator?.namedChildren.find((n) => n?.type === 'call');
    const fn = call?.childForFieldName('function');
    if (!call || fn?.type !== 'attribute') continue;
    const method = LOWER_METHODS[fn.childForFieldName('attribute')?.text ?? ''];
    if (!method || method === '*') continue;
    if (keywordArgument(call, 'include_in_schema')?.text === 'False') continue;
    const first = call.childForFieldName('arguments')?.namedChildren.find((n) => n?.type !== 'keyword_argument') ?? null;
    if (!first) continue;
    const path = pythonString(first);
    if (path === null) {
      out.dynamic += 1;
      continue;
    }
    if (!path.startsWith('/') && path !== '') continue;
    const prefix = prefixes.get(fn.childForFieldName('object')?.text ?? '') ?? '';
    out.routes.push(route(method, joinRoutePath(prefix, path), file, decorator!, 'fastapi'));
  }
}

function keywordArgument(call: Node, name: string): Node | null {
  for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) {
    if (arg?.type === 'keyword_argument' && arg.childForFieldName('name')?.text === name) return arg.childForFieldName('value');
  }
  return null;
}

/** A plain Python string literal's content; null for an f-string with a substitution, or not a string. */
function pythonString(node: Node): string | null {
  if (node.type !== 'string') return null;
  if (node.namedChildren.some((n) => n?.type === 'interpolation')) return null;
  return node.namedChildren
    .filter((n) => n?.type === 'string_content')
    .map((n) => n!.text)
    .join('');
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function readGo(root: Node, file: string, out: FileRoutes): void {
  // `v1 := r.Group("/v1")` (gin, echo, fiber), resolved in source order so a
  // group of a group carries both prefixes.
  const groups = new Map<string, string>();
  for (const decl of root.descendantsOfType(['short_var_declaration', 'assignment_statement'])) {
    if (!decl) continue;
    const left = decl.childForFieldName('left')?.namedChildren[0];
    const right = decl.childForFieldName('right')?.namedChildren[0];
    if (left?.type !== 'identifier' || right?.type !== 'call_expression') continue;
    const group = groupPrefix(right, groups);
    if (group !== null) groups.set(left.text, group);
  }

  for (const call of root.descendantsOfType('call_expression')) {
    if (!call) continue;
    const fn = call.childForFieldName('function');
    if (fn?.type !== 'selector_expression') continue;
    const name = fn.childForFieldName('field')?.text ?? '';
    const args = argumentNodes(call);
    if (args.length < 2) continue;

    let methods: string[];
    let raw: string | null;
    if (name === 'HandleFunc' || name === 'Handle') {
      raw = goString(args[0]);
      if (raw === null) {
        out.dynamic += 1;
        continue;
      }
      const pattern = GO_HTTP_METHOD.exec(raw);
      if (pattern) {
        methods = [pattern[1]];
        raw = pattern[2];
      } else {
        methods = gorillaMethods(call) ?? ['*'];
      }
    } else {
      const method = GO_METHODS[name];
      if (!method) continue;
      raw = goString(args[0]);
      if (raw === null) {
        out.dynamic += 1;
        continue;
      }
      methods = [method];
    }
    // `mux.Handle("example.com/x", h)`: a host pattern is not a path we can compare.
    if (!raw.startsWith('/')) continue;

    const receiver = fn.childForFieldName('operand');
    const prefix = [...routeClosurePrefixes(call), receiverPrefix(receiver, groups)];
    for (const method of methods) out.routes.push(route(method, joinRoutePath(...prefix, raw), file, call, 'go'));
  }
}

/** `x.Group("/p")`, or `x.Group("/p")` where `x` is itself a group. Null when `call` is not one. */
function groupPrefix(call: Node, groups: Map<string, string>): string | null {
  const fn = call.childForFieldName('function');
  if (fn?.type !== 'selector_expression' || fn.childForFieldName('field')?.text !== 'Group') return null;
  const path = goString(argumentNodes(call)[0] ?? null);
  if (path === null) return null;
  return joinRoutePath(receiverPrefix(fn.childForFieldName('operand'), groups), path);
}

function receiverPrefix(receiver: Node | null, groups: Map<string, string>): string {
  if (!receiver) return '';
  if (receiver.type === 'identifier') return groups.get(receiver.text) ?? '';
  if (receiver.type === 'call_expression') return groupPrefix(receiver, groups) ?? '';
  return '';
}

/** chi: every `r.Route("/p", func(r chi.Router) { … })` the call sits inside, outermost first. */
function routeClosurePrefixes(call: Node): string[] {
  const out: string[] = [];
  for (let node = call.parent; node; node = node.parent) {
    if (node.type !== 'func_literal') continue;
    const outer = node.parent?.parent;
    const fn = outer?.type === 'call_expression' ? outer.childForFieldName('function') : null;
    if (fn?.type !== 'selector_expression' || fn.childForFieldName('field')?.text !== 'Route') continue;
    const path = goString(argumentNodes(outer!)[0] ?? null);
    if (path !== null) out.unshift(path);
  }
  return out;
}

/** gorilla/mux: `r.HandleFunc("/x", h).Methods("GET", "POST")`. */
function gorillaMethods(call: Node): string[] | null {
  const selector = call.parent;
  const outer = selector?.parent;
  if (selector?.type !== 'selector_expression' || selector.childForFieldName('field')?.text !== 'Methods') return null;
  if (outer?.type !== 'call_expression') return null;
  const methods = argumentNodes(outer)
    .map((n) => goString(n))
    .filter((m): m is string => !!m)
    .map((m) => m.toUpperCase());
  return methods.length ? methods : null;
}

function goString(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === 'interpreted_string_literal') {
    // An escape inside a route literal is rare enough to read as text.
    return node.namedChildren
      .filter((n) => n?.type === 'interpreted_string_literal_content' || n?.type === 'escape_sequence')
      .map((n) => n!.text)
      .join('');
  }
  if (node.type === 'raw_string_literal') return node.text.slice(1, -1);
  return null;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function route(method: string, path: string, file: string, node: Node, framework: RouteFramework): DeclaredRoute {
  return { method, path, file, line: node.startPosition.row + 1, framework };
}

function argumentNodes(call: Node): Node[] {
  return (call.childForFieldName('arguments')?.namedChildren ?? []).filter((n): n is Node => !!n && n.type !== 'comment');
}

function firstArgument(call: Node): Node | null {
  return argumentNodes(call)[0] ?? null;
}

function isEcmaStringLike(node: Node): boolean {
  return node.type === 'string' || node.type === 'template_string' || node.type === 'array';
}

/**
 * A literal's strings: `'a'` → `['a']`, `['a', 'b']` → both, a template with
 * no substitution → its text. Null for anything not literal (an identifier, a
 * template with `${…}`), so the caller counts it as dynamic.
 */
function ecmaStrings(node: Node | null): string[] | null {
  if (!node) return null;
  if (node.type === 'string') return [node.namedChildren.map((n) => n?.text ?? '').join('')];
  if (node.type === 'template_string') {
    if (node.namedChildren.some((n) => n?.type === 'template_substitution')) return null;
    return [node.namedChildren.map((n) => n?.text ?? '').join('')];
  }
  if (node.type === 'array') {
    const out: string[] = [];
    for (const item of node.namedChildren) {
      const strings = ecmaStrings(item);
      if (!strings) return null;
      out.push(...strings);
    }
    return out;
  }
  return null;
}
