#!/usr/bin/env node
/**
 * Generates the docs page's reference digest — the two tables no one should
 * maintain by hand.
 *
 *   apps/api/openapi.json                 → REST endpoints (method/path/tag/summary)
 *   apps/api/src/ ** /*.controller.ts     → the role each endpoint requires
 *   apps/api/src/mcp/mcp.service.ts       → the MCP tools and their inputs
 *                                         ↓
 *   apps/web/src/pages/docs/reference.generated.json   (committed, like schema.d.ts)
 *
 * Committed rather than built at page load for the same reason `schema.d.ts` is:
 * the web app does not reach across the workspace boundary into apps/api, and a
 * 372 KB OpenAPI document has no business in a browser bundle.
 *
 * Run via `make docs-reference`, or as part of `make api-client`.
 *
 * Everything here is a source scan, not a runtime introspection: the MCP server
 * speaks stdio and would need Postgres, MinIO and ArcadeDB up just to list its
 * own tools. A scan can go stale silently, though, so the floors at the bottom
 * fail the run rather than emit an empty page.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const API_SRC = join(REPO, 'apps/api/src')
const OPENAPI = join(REPO, 'apps/api/openapi.json')
const MCP_SERVICE = join(API_SRC, 'mcp/mcp.service.ts')
const OUT = join(REPO, 'apps/web/src/pages/docs/reference.generated.json')

/** A parse that stops matching must fail loudly, not quietly empty the page. */
const MIN_ENDPOINTS = 100
const MIN_TOOLS = 20

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete']

// ---------------------------------------------------------------- @Access scan

/**
 * A handler's guard decorators surround its route decorator — `@Public()` sits
 * above it in `auth-flow.controller.ts` and below it in `app.controller.ts`,
 * `@Access` sits below it everywhere, and `@PlatformAdmin()` is applied to the
 * whole class in `users.controller.ts`. So the scan reads the entire decorator
 * block around each route (up through contiguous decorators/comments, down to
 * the handler signature) and folds in the class-level flags. The result keys on
 * `METHOD /full/path`, which is what joins it onto the OpenAPI operations.
 */
function scanAccess() {
  const access = new Map()
  for (const file of walk(API_SRC)) {
    if (!file.endsWith('.controller.ts')) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    const source = lines.join('\n')

    const prefix = (source.match(/@Controller\(\s*'([^']*)'/) ?? [, ''])[1]
    // Class-level guards: whatever is decorating the class, above @Controller.
    const head = source.slice(0, source.indexOf('@Controller('))
    const classPublic = /@Public\(\)/.test(head)
    const classPlatformAdmin = /@PlatformAdmin\(\)/.test(head)

    for (let i = 0; i < lines.length; i += 1) {
      const route = lines[i].match(/^\s*@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/)
      if (!route) continue

      const window = decoratorWindow(lines, i)
      const acc = window.match(/@Access\(\s*'([^']+)'\s*(?:,\s*'([^']+)')?/)

      access.set(`${route[1].toUpperCase()} ${joinPath(prefix, route[2] ?? '')}`, {
        role: acc?.[1] ?? null,
        source: acc?.[2] ?? null,
        public: classPublic || /@Public\(\)/.test(window),
        platformAdmin: classPlatformAdmin || /@PlatformAdmin\(\)/.test(window),
      })
    }
  }
  return access
}

/** The decorator block around line `i`: up through decorators, down to the handler. */
function decoratorWindow(lines, i) {
  let start = i
  while (start > 0 && /^\s*(@|\/\/|\*|\/\*|$)/.test(lines[start - 1])) start -= 1

  let end = i + 1
  while (end < lines.length) {
    const line = lines[end]
    // The handler signature ends the block: a non-decorator line that opens a call.
    if (!/^\s*(@|\/\/|\*|\/\*|$)/.test(line)) break
    end += 1
  }
  return lines.slice(start, end + 1).join('\n')
}

function joinPath(prefix, path) {
  const parts = [prefix, path].filter(Boolean).join('/')
  return `/${parts.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')}`
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

// ---------------------------------------------------------------- endpoints

function readEndpoints(access) {
  const doc = JSON.parse(readFileSync(OPENAPI, 'utf8'))
  const endpoints = []

  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(operations)) {
      if (!HTTP_METHODS.includes(method)) continue

      const key = `${method.toUpperCase()} ${path}`
      const acl = access.get(key) ?? access.get(key.replace(/\{(\w+)\}/g, ':$1'))

      endpoints.push({
        method: method.toUpperCase(),
        path,
        tag: op.tags?.[0] ?? 'other',
        summary: op.summary ?? op.description?.split('\n')[0] ?? '',
        // `null` role + not public = authenticated, but with no workspace check
        // — the exact gap CLAUDE.md warns about when adding a route. The table
        // renders it as a warning rather than a blank.
        role: acl?.role ?? null,
        source: acl?.source ?? null,
        public: acl?.public ?? false,
        platformAdmin: acl?.platformAdmin ?? false,
      })
    }
  }

  endpoints.sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  return endpoints
}

// ---------------------------------------------------------------- MCP tools

/**
 * Each tool is `server.registerTool('name', { description, inputSchema }, handler)`.
 * The config object is taken by brace balance (descriptions contain braces and
 * parentheses, so a regex over the whole call is not safe), then two fields are
 * read out of it: the description string, and the top-level keys of the zod
 * `inputSchema` — again by brace balance, since a key's value can be a chained,
 * multi-line zod expression.
 */
function readMcpTools() {
  const src = readFileSync(MCP_SERVICE, 'utf8')
  const tools = []
  const call = /server\.registerTool\(\s*'([^']+)'\s*,\s*\{/g

  let match
  while ((match = call.exec(src))) {
    const name = match[1]
    const config = balanced(src, src.indexOf('{', match.index + match[0].length - 1))
    if (!config) continue

    tools.push({
      name,
      description: readDescription(config),
      inputs: readInputs(config),
    })
  }

  tools.sort((a, b) => a.name.localeCompare(b.name))
  return tools
}

/** Text inside the braces starting at `open`, brace-balanced, quotes skipped. */
function balanced(src, open) {
  if (src[open] !== '{') return null
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const char = src[i]
    if (char === "'" || char === '"' || char === '`') {
      i = skipString(src, i)
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return null
}

function skipString(src, start) {
  const quote = src[start]
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') i += 1
    else if (src[i] === quote) return i
  }
  return src.length
}

/**
 * Prettier wraps long descriptions into adjacent string literals; joining every
 * literal up to the next key keeps the sentence whole.
 */
function readDescription(config) {
  const at = config.match(/description:\s*/)
  if (!at) return ''
  const rest = config.slice(at.index + at[0].length)
  const literals = rest.slice(0, rest.search(/\n\s*\w+:/) + 1 || rest.length).match(/'(?:[^'\\]|\\.)*'/g)
  if (!literals) return ''
  return literals
    .map((literal) => literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, ' '))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Top-level keys of `inputSchema: { … }`, with optionality from the zod chain. */
function readInputs(config) {
  const at = config.match(/inputSchema:\s*\{/)
  if (!at) return []
  const body = balanced(config, config.indexOf('{', at.index + at[0].length - 1))
  if (body === null) return []

  const inputs = []
  let depth = 0
  let keyStart = 0

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (char === "'" || char === '"' || char === '`') {
      i = skipString(body, i)
      continue
    }
    if (char === '{' || char === '(' || char === '[') depth += 1
    else if (char === '}' || char === ')' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      pushInput(inputs, body.slice(keyStart, i))
      keyStart = i + 1
    }
  }
  pushInput(inputs, body.slice(keyStart))
  return inputs
}

function pushInput(inputs, chunk) {
  const key = chunk.match(/^\s*(\w+)\s*:/)
  if (!key) return
  inputs.push({ name: key[1], optional: /\.optional\(\)/.test(chunk) })
}

// ---------------------------------------------------------------- emit

const access = scanAccess()
const endpoints = readEndpoints(access)
const mcpTools = readMcpTools()

if (endpoints.length < MIN_ENDPOINTS) {
  console.error(`✗ only ${endpoints.length} endpoints found (expected ≥ ${MIN_ENDPOINTS}) — is openapi.json current?`)
  process.exit(1)
}
if (mcpTools.length < MIN_TOOLS) {
  console.error(`✗ only ${mcpTools.length} MCP tools found (expected ≥ ${MIN_TOOLS}) — did registerTool's shape change?`)
  process.exit(1)
}

// No timestamp: it would churn the diff on every run and says nothing the git
// history does not already say.
writeFileSync(OUT, `${JSON.stringify({ endpoints, mcpTools }, null, 2)}\n`)

const unguarded = endpoints.filter((e) => !e.role && !e.public && !e.platformAdmin).length
console.log(`✔ ${endpoints.length} endpoints (${unguarded} without @Access), ${mcpTools.length} MCP tools → ${OUT.replace(`${REPO}/`, '')}`)
