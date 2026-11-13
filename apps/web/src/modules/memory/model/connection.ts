/**
 * How a client reaches a memory bank (#1010, docs/features/80): one bank,
 * several wires. Pure: the settings page shows these, and nothing here knows
 * a real bank id or key — `<bank-id>` and the env var stand in for both.
 */
import { KEY_ENV } from '@/entities/access'

export const BANK_PLACEHOLDER = '<bank-id>'

export interface MemoryEndpoints {
  /** The Hindsight base URL: `API_PUBLIC_URL`. */
  base: string
  /** MCP, Hindsight's tools (retain, recall, reflect). */
  mcp: string
  /** MCP, the reference memory server's nine graph tools. */
  graph: string
  /** MCP, the memory tool's six commands as one tool named `memory`. */
  files: string
  /** REST, one call per memory tool `tool_use`: the raw input in, `{content, is_error}` out. */
  tool: string
}

export function memoryEndpoints(apiUrl: string): MemoryEndpoints {
  const mcp = `${apiUrl}/mcp/${BANK_PLACEHOLDER}`
  return { base: apiUrl, mcp: `${mcp}/`, graph: `${mcp}/graph`, files: `${mcp}/files`, tool: `${apiUrl}/v1/default/banks/${BANK_PLACEHOLDER}/memory-tool` }
}

/** The tool type a request declares; the bank serves its commands. */
export const MEMORY_TOOL_TYPE = 'memory_20250818'
/** The bridge's command line, as the docs name it: a stdio-only client starts it in place of a server. */
export const BRIDGE_COMMAND = 'npx mcp-remote <url> --header "Authorization: Bearer …"'

export const HANDLER_LANGS = ['typescript', 'python'] as const
export type HandlerLang = (typeof HANDLER_LANGS)[number]

/**
 * A memory tool handler that forwards every command to the bank. TypeScript
 * uses the SDK's `betaMemoryTool` (its runner turns a `ToolError` into the
 * `is_error` result verbatim); Python answers a `tool_use` block by hand, so
 * it depends on no SDK helper.
 */
export function memoryToolHandler(lang: HandlerLang, endpoint: string): string {
  if (lang === 'python') {
    return `import os
import requests

ENDPOINT = "${endpoint}"


def run_memory_tool(block):
    """Answers one \`memory\` tool_use block from the bank."""
    res = requests.post(
        ENDPOINT,
        json=block.input,
        headers={"Authorization": f"Bearer {os.environ['${KEY_ENV}']}"},
        timeout=30,
    )
    res.raise_for_status()
    out = res.json()
    return {"type": "tool_result", "tool_use_id": block.id, "content": out["content"], "is_error": out["is_error"]}


# tools=[{"type": "${MEMORY_TOOL_TYPE}", "name": "memory"}]
# For each tool_use block named "memory", send run_memory_tool(block) back in the next user turn.
`
  }
  return `import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory'
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError'

const ENDPOINT = '${endpoint}'

// Each command goes to the bank as Claude wrote it; the answer is the tool result.
async function forward(input: unknown): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: \`Bearer \${process.env.${KEY_ENV}}\`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(\`memory bank answered \${res.status}\`)
  const { content, is_error } = (await res.json()) as { content: string; is_error: boolean }
  if (is_error) throw new ToolError(content)
  return content
}

export const memory = betaMemoryTool({
  view: forward,
  create: forward,
  str_replace: forward,
  insert: forward,
  delete: forward,
  rename: forward,
})
// Pass \`memory\` in \`tools\` to client.beta.messages.toolRunner({ … }).
`
}

/**
 * A stdio-only client's config: `mcp-remote` bridges it to an HTTP endpoint.
 * The space in "Bearer …" lives in env, not args, because several hosts split
 * args on spaces (the Claude Desktop form on the Connect AI page).
 */
export function stdioBridgeConfig(url: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        memory: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}', '--transport', 'http-only'],
          env: { AUTH_HEADER: 'Bearer <your-api-key>' },
        },
      },
    },
    null,
    2,
  )
}
