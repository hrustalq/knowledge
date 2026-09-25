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
 * Pure: the page decides which key to show, this decides where it goes.
 */

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
}

export interface McpClientGuide {
  id: string
  name: string
  /** Shell one-liner that registers the server, when the client has one. */
  command: string | null
  config: { path: string; lang: 'json' | 'toml'; code: string }
  /** Where the client reads skills from — the SKILL.md goes in `<dir>/knowledge-platform/`. */
  skillDir: string | null
  /** Reads the key from KNOWLEDGE_API_KEY, so the page shows the `export` line. */
  usesEnv: boolean
  /** i18n key under connect.clients.notes — the one thing that goes wrong with this client. */
  note: string
  docs: string
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

export function mcpClients(input: McpClientInput): McpClientGuide[] {
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
      skillDir: '~/.claude/skills',
      usesEnv: auth,
      note: 'claudeCode',
      docs: 'https://code.claude.com/docs/en/mcp',
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
      skillDir: '~/.agents/skills',
      usesEnv: auth,
      note: 'codex',
      docs: 'https://developers.openai.com/codex/mcp',
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
      skillDir: '~/.agents/skills',
      usesEnv: auth,
      note: 'gemini',
      docs: 'https://geminicli.com/docs/tools/mcp-server/',
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
      skillDir: '~/.agents/skills',
      usesEnv: auth,
      note: 'cursor',
      docs: 'https://cursor.com/docs/context/mcp',
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
      skillDir: '~/.agents/skills',
      usesEnv: false,
      note: 'vscode',
      docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    },
    {
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
      note: 'claudeDesktop',
      docs: 'https://github.com/geelen/mcp-remote',
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
      skillDir: '~/.agents/skills',
      usesEnv: auth,
      note: 'windsurf',
      docs: 'https://docs.devin.ai/desktop/cascade/mcp',
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
            [name]: { type: 'remote', url, enabled: true, oauth: false, ...header(`{env:${KEY_ENV}}`) },
          },
        }),
      },
      skillDir: '~/.agents/skills',
      usesEnv: auth,
      note: 'opencode',
      docs: 'https://opencode.ai/docs/mcp-servers/',
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
      skillDir: '~/.agents/skills',
      usesEnv: false,
      note: 'zed',
      docs: 'https://zed.dev/docs/ai/mcp',
    },
    {
      id: 'http',
      name: 'Any client · curl',
      command: null,
      config: {
        path: 'POST ' + url,
        lang: 'json',
        // The raw shape, for a client this list does not name and for checking
        // a key works before blaming the client.
        code: [
          `curl -s ${url} \\`,
          ...(auth ? [`  -H "Authorization: Bearer $${KEY_ENV}" \\`] : []),
          `  -H "Content-Type: application/json" \\`,
          `  -H "Accept: application/json, text/event-stream" \\`,
          `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"knowledge_whoami","arguments":{}}}'`,
        ].join('\n'),
      },
      skillDir: null,
      usesEnv: auth,
      note: 'http',
      docs: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports',
    },
  ]
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
