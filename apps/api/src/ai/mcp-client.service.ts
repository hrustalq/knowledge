import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AiPlugin } from '@prisma/client';
import type { AiPluginTool } from '@knowledge/contracts';
import { t } from '../i18n/t.js';

/** Namespace separator: `mcp__<plugin slug>__<tool>` stays inside `^[a-zA-Z0-9_-]+$`. */
export const MCP_TOOL_PREFIX = 'mcp__';
const SEP = '__';

/** Idle connections are dropped after this long. */
const IDLE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;

interface PooledConnection {
  client: Client;
  /** Identity of the config the connection was opened with — a settings edit invalidates it. */
  signature: string;
  idleTimer: NodeJS.Timeout;
}

/**
 * MCP client for plugins (docs/features/12).
 *
 * The repo already ships an MCP *server* (src/mcp.main.ts); this is the other
 * direction — a workspace registers an external MCP server and its tools join
 * the assistant's bounded tool harness.
 *
 * HTTP transports only, deliberately: stdio would mean spawning processes on
 * the API host on the strength of a URL typed into a settings form.
 *
 * Streamable HTTP is the default and the one to pick. SSE is kept only because
 * the SDK's own deprecation note says clients still need both while servers
 * migrate — it is a compatibility path for existing servers, not a choice an
 * admin should make for a new one.
 */
@Injectable()
export class McpClientService implements OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);
  private readonly pool = new Map<string, PooledConnection>();

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.pool.keys()].map((id) => this.release(id)));
  }

  /** Connects and lists the server's tools. Throws with a readable message on failure. */
  async discover(plugin: AiPlugin, authValue: string | null): Promise<AiPluginTool[]> {
    const client = await this.connect(plugin, authValue);
    const { tools } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    return tools.map((t) => ({
      name: t.name,
      description: (t.description ?? '').slice(0, 500),
      // Kept verbatim: a model calls a tool far better with the server's real
      // argument schema than with a shrug of `type: object`.
      ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
    }));
  }

  /**
   * Executes one namespaced tool call. The result is returned as text; the
   * caller wraps it as untrusted data before it reaches the model.
   */
  async callTool(
    plugin: AiPlugin,
    authValue: string | null,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; ok: boolean }> {
    try {
      const client = await this.connect(plugin, authValue);
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      const text = Array.isArray(result.content)
        ? result.content
            .map((part) =>
              part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
                ? part.text
                : JSON.stringify(part),
            )
            .join('\n')
        : JSON.stringify(result.content ?? result);
      return { content: text, ok: result.isError !== true };
    } catch (err) {
      // A broken plugin must not break the turn — the model gets a structured
      // error and can carry on with its other tools.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`MCP plugin ${plugin.name} tool ${toolName} failed: ${message.slice(0, 300)}`);
      await this.release(plugin.id);
      return { content: JSON.stringify({ error: `Plugin "${plugin.name}" failed: ${message.slice(0, 200)}` }), ok: false };
    }
  }

  /** Drops a plugin's pooled connection — called whenever its settings change. */
  async release(pluginId: string): Promise<void> {
    const held = this.pool.get(pluginId);
    if (!held) return;
    clearTimeout(held.idleTimer);
    this.pool.delete(pluginId);
    await held.client.close().catch(() => undefined);
  }

  private async connect(plugin: AiPlugin, authValue: string | null): Promise<Client> {
    const signature = `${plugin.transport}|${plugin.url}|${plugin.authHeader ?? ''}|${authValue ?? ''}`;
    const held = this.pool.get(plugin.id);
    if (held && held.signature === signature) {
      held.idleTimer.refresh();
      return held.client;
    }
    if (held) await this.release(plugin.id);

    const url = new URL(plugin.url);
    const headers: Record<string, string> =
      plugin.authHeader && authValue ? { [plugin.authHeader]: authValue } : {};

    const transport =
      plugin.transport === 'sse'
        ? // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy servers still speak only SSE
          new SSEClientTransport(url, { requestInit: { headers } })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers } });

    const client = new Client({ name: 'knowledge-platform', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });

    const idleTimer = setTimeout(() => void this.release(plugin.id), IDLE_MS);
    idleTimer.unref?.();
    this.pool.set(plugin.id, { client, signature, idleTimer });
    return client;
  }
}

/** `mcp__jira__search_issues` → `{ slug: 'jira', tool: 'search_issues' }`. */
export function parseToolName(namespaced: string): { slug: string; tool: string } | null {
  if (!namespaced.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = namespaced.slice(MCP_TOOL_PREFIX.length);
  const at = rest.indexOf(SEP);
  if (at <= 0) return null;
  return { slug: rest.slice(0, at), tool: rest.slice(at + SEP.length) };
}

export function toolNameFor(slug: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${slug}${SEP}${tool}`;
}

/** Plugin name → a slug safe for a tool name (and stable enough to route on). */
export function slugFor(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-/g, '_')
      .slice(0, 32) || 'plugin'
  );
}

/**
 * Validates a plugin URL before anything connects to it.
 *
 * An admin typing a URL into a form is a legitimate way to reach an internal
 * service, and it is also the classic SSRF shape — so private and loopback
 * targets are refused unless AI_PLUGINS_ALLOW_PRIVATE_URLS says this is a
 * self-hosted deployment where that is the point. The DNS name is resolved
 * here rather than trusting the literal host, so `internal.example.com`
 * pointing at 127.0.0.1 is caught too.
 */
export async function assertSafePluginUrl(raw: string, allowPrivate: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException(t('error.ai.pluginUrlInvalid'));
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new BadRequestException(t('error.ai.pluginUrlNotHttps'));
  }
  if (allowPrivate) return;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new BadRequestException(t('error.ai.pluginHostUnresolved', { host }));
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new BadRequestException(
        t('error.ai.pluginUrlPrivate', { address }),
      );
    }
  }
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const v6 = address.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:10.0.0.1) — fall through to the v4 checks.
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (!mapped) return false;
    address = mapped[1];
  }
  const [a, b] = address.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}
