/**
 * How each AI client connects to the knowledge MCP server (docs/features/33).
 *
 * One entry per client, each producing the exact text to paste: a CLI one-liner
 * where the client has one, and the config file it writes. Checked against each
 * vendor's documentation in September 2026 — the differences that matter are
 * not cosmetic, which is why this is a table of client-specific generators and
 * not one JSON blob with a "works in most clients" caption:
 *
 * - The env-var syntax differs in every client (`${VAR}`, `${env:VAR}`,
 *   `{env:VAR}`, `$VAR`, a named field in TOML), and a wrong one is sent to the
 *   server literally — a 401 that names nothing.
 * - Claude Code reads an entry without `type` as stdio; Gemini reads `url` as
 *   SSE and needs `httpUrl` for Streamable HTTP; opencode tries OAuth first
 *   unless told not to.
 * - Some clients cannot read an env var in a header at all (Claude Desktop,
 *   Zed; VS Code's is currently broken), so those get the key inline or a
 *   prompted input.
 *
 * Pure: the page decides which key to show, this decides where it goes. Read by
 * the web wizard, the manage page and the API (#1346); logos and notes stay in the web app.
 */

import type { CaptureKitClient } from '@knowledge/contracts/captures'
import { SKILL_DIRS, SKILL_DIR_KEYS } from '@knowledge/contracts/identity'

export const KEY_ENV = 'KNOWLEDGE_API_KEY'
export const SKILL_NAME = 'knowledge-platform'

export interface McpClientInput {
  /** The Streamable HTTP endpoint. */
  url: string
  serverName: string
  /** false under AUTH_MODE=none — every snippet drops its credential. */
  auth: boolean
  /** A key minted on this page just now, or null — clients that cannot read env get a placeholder then. */
  key: string | null
  /** The generic client's name in the reader's language. */
  anyClientName?: string
  /**
   * How the person chose to connect (#1371), meaningful only while the server
   * signs clients in with OAuth (#1352): `oauth` renders every client whose
   * docs describe MCP OAuth with no credential at all, and marks it `oauth`; a
   * client that cannot keeps its key snippet. Absent = `key`.
   */
  signIn?: 'key' | 'oauth'
}

export interface McpClientGuide {
  id: string
  name: string
  /** Shell one-liner that registers the server, when the client has one. */
  command: string | null
  config: { path: string; lang: 'json' | 'toml' | 'yaml'; code: string }
  /** Where the client reads skills from — the SKILL.md goes in `<dir>/knowledge-platform/`. */
  skillDir: string | null
  /** Reads the key from KNOWLEDGE_API_KEY, so the page shows the `export` line. */
  usesEnv: boolean
  /** The capture kit this client's hooks can run (issue #73), or null — it then captures through the skill alone. */
  captureKit: CaptureKitClient | null
  /** i18n key under connect.clients.notes — the one thing that goes wrong with this client. */
  note: string
  docs: string
  /** The config a repository can commit (#1348), or why this client has none. */
  projectConfig: ProjectConfig | { refused: ProjectRefusal }
  /**
   * How the client starts a browser sign-in (#1371), checked against its
   * vendor's docs on 2026-11-20: a command to run (in the client, or a shell
   * for its CLI), or null when it asks by itself on the first connection.
   * Set on both renderings, so a page can offer the choice; absent when its
   * docs describe no MCP OAuth, so it always takes a key.
   */
  signIn?: { command: string | null }
  /** Rendered for browser sign-in (#1352, #1371): no key step, no header, the client gets its own grant. */
  oauth?: true
}

/**
 * A project-level MCP config: a JSON file at `path` (from the repository root)
 * whose credential is always a reference to KNOWLEDGE_API_KEY in the client's
 * own syntax, never a key, so it is safe to commit. `docs` is the vendor page
 * that says the client reads this file and expands the variable there.
 */
export interface ProjectConfig {
  path: string
  code: string
  docs: string
}

/** No project-level JSON config this setup can write, or no documented way to read the key from the environment in one. */
export type ProjectRefusal = 'no-project-config' | 'no-env-in-headers'

export function hasProjectConfig(c: McpClientGuide): c is McpClientGuide & { projectConfig: ProjectConfig } {
  return 'code' in c.projectConfig
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

/**
 * Each client's project config (#1348), checked against its vendor's docs in
 * November 2026. A client gets one only where the docs state both a
 * project-level file and an env reference for the key there, and its file is
 * the same JSON as its user-level config. Run per client in #1351: Claude Code,
 * Kimi and pi ask to approve or trust a folder's servers first.
 */
const PROJECT: Record<string, { path: string; docs: string } | ProjectRefusal> = {
  'claude-code': { path: '.mcp.json', docs: 'https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json' },
  cursor: { path: '.cursor/mcp.json', docs: 'https://cursor.com/docs/context/mcp' },
  kimi: { path: '.kimi-code/mcp.json', docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html' },
  pi: { path: '.pi/mcp.json', docs: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md' },
  omp: { path: '.omp/mcp.json', docs: 'https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md' },
  // TOML (`.codex/config.toml`, trusted projects only): no jq merge for it.
  codex: 'no-project-config',
  // Expansion is documented for settings strings in general, not for MCP headers.
  gemini: 'no-env-in-headers',
  qwen: 'no-env-in-headers',
  deepseek: 'no-project-config',
  hermes: 'no-project-config',
  vscode: 'no-env-in-headers',
  'claude-desktop': 'no-project-config',
  // `.devin/mcp_config.json` exists, but `${env:}` is documented for OAuth fields only.
  windsurf: 'no-env-in-headers',
  // The V1 `mcp.<name>` shape: opencode 1.x rejects V2's `mcp.servers`, and 2.x still reads V1 (#1351).
  opencode: { path: 'opencode.json', docs: 'https://opencode.ai/docs/config/' },
  zed: 'no-env-in-headers',
  http: 'no-project-config',
}

export function mcpClients(input: McpClientInput): McpClientGuide[] {
  // Browser sign-in is the credential-free rendering (an Authorization header turns
  // OAuth off in every one of these clients), taken only where the client can sign in.
  const signedIn = input.signIn === 'oauth' && input.auth ? clientTable({ ...input, auth: false }, true) : null
  return clientTable(input, false).map((keyed, i) => {
    const c = signedIn?.[i]?.signIn ? { ...signedIn[i]!, oauth: true as const } : keyed
    const p = PROJECT[c.id] ?? 'no-project-config'
    return { ...c, projectConfig: typeof p === 'string' ? { refused: p } : { ...p, code: c.config.code } }
  })
}

/** `oauth`: the rendering a browser sign-in uses, for the few clients whose OAuth config is more than "no header". */
function clientTable(input: McpClientInput, oauth: boolean): Omit<McpClientGuide, 'projectConfig'>[] {
  const { url, serverName: name, auth } = input
  const literal = input.key ?? '<your-api-key>'
  const header = (value: string) => (auth ? { headers: { Authorization: `Bearer ${value}` } } : {})

  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      command: `claude mcp add --transport http ${name} ${url} --scope user${
        auth ? ` --header 'Authorization: Bearer \${${KEY_ENV}}'` : ''
      }`,
      config: {
        path: '.mcp.json  (project)  ·  ~/.claude.json  (user)',
        lang: 'json',
        code: json({ mcpServers: { [name]: { type: 'http', url, ...header(`\${${KEY_ENV}}`) } } }),
      },
      skillDir: SKILL_DIRS.claude,
      usesEnv: auth,
      captureKit: 'claude-code',
      note: 'claudeCode',
      docs: 'https://code.claude.com/docs/en/mcp',
      signIn: { command: '/mcp' },
    },
    {
      id: 'codex',
      name: 'Codex',
      command: `codex mcp add ${name} --url ${url}${auth ? ` --bearer-token-env-var ${KEY_ENV}` : ''}`,
      config: {
        path: '~/.codex/config.toml',
        lang: 'toml',
        code: [`[mcp_servers.${name}]`, `url = "${url}"`, ...(auth ? [`bearer_token_env_var = "${KEY_ENV}"`] : [])].join(
          '\n',
        ),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: auth,
      captureKit: 'codex',
      note: 'codex',
      docs: 'https://developers.openai.com/codex/mcp',
      signIn: { command: `codex mcp login ${name}` },
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      command: `gemini mcp add --transport http --scope user${
        auth ? ` --header "Authorization: Bearer \\$${KEY_ENV}"` : ''
      } ${name} ${url}`,
      config: {
        path: '~/.gemini/settings.json',
        lang: 'json',
        code: json({ mcpServers: { [name]: { httpUrl: url, ...header(`$${KEY_ENV}`) } } }),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: auth,
      captureKit: null,
      note: 'gemini',
      docs: 'https://geminicli.com/docs/tools/mcp-server/',
      signIn: { command: `/mcp auth ${name}` },
    },
    {
      // A Gemini CLI fork: `httpUrl` is Streamable HTTP, `$VAR` expands in headers.
      id: 'qwen',
      name: 'Qwen Code',
      command: `qwen mcp add --scope user --transport http${
        auth ? ` --header "Authorization: Bearer \\$${KEY_ENV}"` : ''
      } ${name} ${url}`,
      config: {
        path: '~/.qwen/settings.json',
        lang: 'json',
        code: json({ mcpServers: { [name]: { httpUrl: url, ...header(`$${KEY_ENV}`) } } }),
      },
      skillDir: '~/.qwen/skills',
      usesEnv: auth,
      captureKit: null,
      note: 'qwen',
      docs: 'https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/',
      signIn: { command: '/mcp' },
    },
    {
      // A `url` without `transport` is HTTP; the key is read from the named variable.
      id: 'kimi',
      name: 'Kimi Code',
      command: null,
      config: {
        path: '~/.kimi-code/mcp.json  ·  .kimi-code/mcp.json',
        lang: 'json',
        code: json({ mcpServers: { [name]: { url, ...(auth ? { bearerTokenEnvVar: KEY_ENV } : {}) } } }),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: auth,
      captureKit: null,
      note: 'kimi',
      docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html',
      signIn: { command: `/mcp-config login ${name}` },
    },
    {
      // One dsh-mcp-client row in a Cordis patch layer; `!!js` reads the key from the environment.
      id: 'deepseek',
      name: 'DeepSeek Harness',
      command: null,
      config: {
        path: '$DSH_HOME/cordis.patch.yml  (~/.dsh when unset)',
        lang: 'yaml',
        code: [
          '- insert:',
          `    - id: mcp-${name}`,
          "      name: '@deepseek-ai/dsh-mcp-client'",
          '      config:',
          `        serverName: ${name}`,
          '        transport: streamable-http',
          `        url: ${url}`,
          ...(auth ? ['        headers:', `          Authorization: !!js '\`Bearer \${process.env.${KEY_ENV}}\`'`] : []),
        ].join('\n'),
      },
      // dsh-skill-filesystem reads ~/.agents/skills beside its own $DSH_HOME/skills (#1351).
      skillDir: SKILL_DIRS.agents,
      usesEnv: auth,
      captureKit: null,
      note: 'deepseek',
      docs: 'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md',
    },
    {
      id: 'pi',
      name: 'pi',
      command: `pi mcp add ${name} --url ${url}${auth ? ` --bearer-token-env-var ${KEY_ENV}` : ''}`,
      config: {
        path: '~/.pi/agent/mcp.json',
        lang: 'json',
        // pi defers MCP tools behind its search; the two a ticket starts with stay in view (#1362).
        code: json({
          mcpServers: {
            [name]: { url, ...header(`\${${KEY_ENV}}`), toolExposure: { knowledge_whoami: 'direct', knowledge_context: 'direct' } },
          },
        }),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: auth,
      captureKit: null,
      note: 'pi',
      docs: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md',
      signIn: { command: `/mcp login ${name}` },
    },
    {
      id: 'omp',
      name: 'Oh My Pi',
      command: null,
      config: {
        path: '~/.omp/agent/mcp.json',
        lang: 'json',
        code: json({ mcpServers: { [name]: { type: 'http', url, ...header(`\${${KEY_ENV}}`) } } }),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: auth,
      captureKit: null,
      note: 'omp',
      docs: 'https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md',
      signIn: { command: `/mcp reauth ${name}` },
    },
    {
      // `${VAR}` expands from the environment or ~/.hermes/.env.
      id: 'hermes',
      name: 'Hermes Agent',
      command: null,
      config: {
        path: '~/.hermes/config.yaml',
        lang: 'yaml',
        code: [
          'mcp_servers:',
          `  ${name}:`,
          `    url: "${url}"`,
          ...(oauth ? ['    auth: oauth'] : []),
          ...(auth ? ['    headers:', `      Authorization: "Bearer \${${KEY_ENV}}"`] : []),
        ].join('\n'),
      },
      skillDir: '~/.hermes/skills',
      usesEnv: auth,
      captureKit: null,
      note: 'hermes',
      docs: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp',
      signIn: { command: `hermes mcp login ${name}` },
    },
    {
      id: 'cursor',
      name: 'Cursor',
      command: null,
      config: {
        path: '~/.cursor/mcp.json  ·  .cursor/mcp.json',
        lang: 'json',
        code: json({ mcpServers: { [name]: { url, ...header(`\${env:${KEY_ENV}}`) } } }),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: auth,
      captureKit: 'cursor',
      note: 'cursor',
      docs: 'https://cursor.com/docs/context/mcp',
      signIn: { command: null },
    },
    {
      id: 'vscode',
      name: 'VS Code · Copilot',
      command: null,
      config: {
        path: '.vscode/mcp.json',
        lang: 'json',
        code: json({
          ...(auth
            ? {
                inputs: [
                  { type: 'promptString', id: `${name}-key`, description: 'Knowledge API key', password: true },
                ],
              }
            : {}),
          servers: { [name]: { type: 'http', url, ...header(`\${input:${name}-key}`) } },
        }),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: false,
      captureKit: null,
      note: 'vscode',
      docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
      signIn: { command: null },
    },
    // Signing in (#1352), Desktop connects natively as a custom connector and
    // opens the browser itself: no key, no mcp-remote.
    oauth
      ? {
          id: 'claude-desktop',
          name: 'Claude Desktop',
          command: null,
          config: { path: 'Settings → Connectors → Add custom connector', lang: 'yaml', code: url },
          skillDir: null,
          usesEnv: false,
          captureKit: null,
          note: 'claudeDesktopOauth',
          docs: 'https://claude.com/docs/connectors/building',
          signIn: { command: null },
        }
      : {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      command: null,
      config: {
        path: '~/Library/Application Support/Claude/claude_desktop_config.json',
        lang: 'json',
        // Desktop's config file only runs local (stdio) servers, so mcp-remote
        // bridges it. The space in "Bearer …" lives in env, not args: several
        // hosts split args on spaces.
        code: json({
          mcpServers: {
            [name]: {
              command: 'npx',
              args: [
                '-y',
                'mcp-remote',
                url,
                ...(auth ? ['--header', 'Authorization:${AUTH_HEADER}'] : []),
                '--transport',
                'http-only',
              ],
              ...(auth ? { env: { AUTH_HEADER: `Bearer ${literal}` } } : {}),
            },
          },
        }),
      },
      skillDir: null,
      usesEnv: false,
      captureKit: null,
      note: 'claudeDesktop',
      docs: 'https://github.com/geelen/mcp-remote',
      // The same client: it can still sign in through the browser instead (#1371).
      signIn: { command: null },
    },
    {
      id: 'windsurf',
      name: 'Windsurf · Devin',
      command: null,
      config: {
        path: '~/.config/devin/mcp_config.json  ·  ~/.codeium/windsurf/mcp_config.json',
        lang: 'json',
        code: json({ mcpServers: { [name]: { serverUrl: url, ...header(`\${env:${KEY_ENV}}`) } } }),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: auth,
      captureKit: null,
      note: 'windsurf',
      docs: 'https://docs.devin.ai/desktop/cascade/mcp',
      signIn: { command: null },
    },
    {
      id: 'opencode',
      name: 'opencode',
      command: null,
      config: {
        path: 'opencode.json  ·  ~/.config/opencode/opencode.json',
        lang: 'json',
        code: json({
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            // `oauth: false` keeps opencode from trying a sign-in over a key; omitted, it signs in (#1371).
            [name]: { type: 'remote', url, enabled: true, ...(oauth ? {} : { oauth: false }), ...header(`{env:${KEY_ENV}}`) },
          },
        }),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: auth,
      captureKit: null,
      note: 'opencode',
      docs: 'https://opencode.ai/docs/mcp-servers/',
      signIn: { command: `opencode mcp auth ${name}` },
    },
    {
      id: 'zed',
      name: 'Zed',
      command: null,
      config: {
        path: '~/.config/zed/settings.json',
        lang: 'json',
        code: json({ context_servers: { [name]: { url, ...header(literal) } } }),
      },
      skillDir: SKILL_DIRS.agents,
      usesEnv: false,
      captureKit: null,
      note: 'zed',
      docs: 'https://zed.dev/docs/ai/mcp',
      signIn: { command: null },
    },
    {
      id: 'http',
      name: input.anyClientName ?? 'Any MCP client',
      command: null,
      config: {
        path: 'POST ' + url,
        lang: 'json',
        // The raw shape, for a client this list does not name and for checking
        // a key works before blaming the client.
        code: [
          `curl -sS ${url} \\`,
          ...(auth ? [`  -H "Authorization: Bearer $${KEY_ENV}" \\`] : []),
          `  -H "Content-Type: application/json" \\`,
          `  -H "Accept: application/json, text/event-stream" \\`,
          `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"knowledge_whoami","arguments":{}}}'`,
        ].join('\n'),
      },
      skillDir: null,
      usesEnv: auth,
      captureKit: null,
      note: 'http',
      docs: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports',
    },
  ]
}

export interface SkillDirGuide {
  dir: string
  /** Names of the clients that read skills from this directory. */
  clients: string[]
  /** Those of them with a capture kit. */
  kits: { client: CaptureKitClient; name: string }[]
}

/** The skills directories the clients read, each with who reads it, in table order (#1343). */
export function skillDirGuides(clients: McpClientGuide[]): SkillDirGuide[] {
  const out = new Map<string, SkillDirGuide>()
  for (const c of clients) {
    if (!c.skillDir) continue
    const guide = out.get(c.skillDir) ?? { dir: c.skillDir, clients: [], kits: [] }
    guide.clients.push(c.name)
    if (c.captureKit) guide.kits.push({ client: c.captureKit, name: c.name })
    out.set(c.skillDir, guide)
  }
  return [...out.values()]
}

/**
 * Fetch the skill straight into a client's skills directory. Fetched rather
 * than pasted so that re-running it later picks up new workspaces and tools.
 */
export function skillInstallCommand(skillUrl: string, dir: string, auth: boolean): string {
  const target = `${dir}/${SKILL_NAME}`
  return [
    `mkdir -p ${target} && \\`,
    `curl -fsSL${auth ? ` -H "Authorization: Bearer $${KEY_ENV}"` : ''} \\`,
    `  ${skillUrl} -o ${target}/SKILL.md`,
  ].join('\n')
}

/**
 * Install the skill as a stack (#945): a core skill plus one per offered
 * toolset, so a client loads a playbook only when its description matches.
 * Null for a directory the server has no stack for. The server renders the
 * installer; a re-run updates the skills and removes one no longer offered.
 */
export function skillStackInstallCommand(mcpUrl: string, dir: string, auth: boolean): string | null {
  const key = SKILL_DIR_KEYS.find((k) => SKILL_DIRS[k] === dir)
  if (!key) return null
  return `curl -fsSL${auth ? ` -H "Authorization: Bearer $${KEY_ENV}"` : ''} \\\n  "${mcpUrl}/skills/install?dir=${key}" | sh`
}

/**
 * The one setup command (#1347): registers the server with `client`, installs
 * the skill and, inside a git repository, the capture kit. `single`,
 * `kit: false`, `project` (#1348: write the repository's committable
 * config instead of registering per user) and `oauth` (#1371) carry the wizard's answers; the
 * server renders the rest.
 */
export function setupInstallCommand(
  mcpUrl: string,
  client: string,
  auth: boolean,
  opts: { single?: boolean; kit?: boolean; project?: boolean; oauth?: boolean } = {},
): string {
  const query = [
    `client=${client}`,
    ...(opts.single ? ['skill=single'] : []),
    ...(opts.kit === false ? ['kit=no'] : []),
    ...(opts.project ? ['scope=project'] : []),
    // #1371: register with no credential and print how the client signs in; the curl still carries the setup key.
    ...(opts.oauth ? ['signIn=oauth'] : []),
  ].join('&')
  return `curl -fsSL${auth ? ` -H "Authorization: Bearer $${KEY_ENV}"` : ''} \\\n  "${mcpUrl}/setup/install?${query}" | sh`
}

/**
 * Install the capture kit (issue #73) into the repository the command runs in.
 * The server renders the installer, so a re-run picks up a new kit version,
 * and it never overwrites a settings file the person already has.
 */
export function captureKitInstallCommand(kitUrl: string, client: CaptureKitClient, auth: boolean): string {
  return `curl -fsSL${auth ? ` -H "Authorization: Bearer $${KEY_ENV}"` : ''} \\\n  "${kitUrl}/install?client=${client}" | sh`
}
