import { Controller, Delete, Get, Header, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import type { McpConnectionInfo } from '@knowledge/contracts';
import { CurrentPrincipal, ReadKeyOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { MCP_SERVER_NAME } from './mcp-tools.js';
import { MCP_SERVER_VERSION, McpService } from './mcp.service.js';

/**
 * MCP over Streamable HTTP (docs/features/33): the stdio server's tool set,
 * reachable by any client that can send a bearer header — Claude Code, Codex,
 * Gemini CLI, Cursor, VS Code and the rest.
 *
 * Stateless on purpose. Each POST builds a server bound to that request's
 * principal and throws it away: there is no session to pin a principal to,
 * nothing to leak between two callers, nothing to lose on a restart or behind a
 * second API replica. The cost is that the server cannot push — GET (the SSE
 * stream) answers 405, which the spec allows and every client falls back from.
 *
 * Authentication is the global AuthGuard, unchanged: `Authorization: Bearer
 * kn_…` resolves the same principal it does for REST. Authorization is per
 * tool, inside McpService — this route has no `@Access` because a JSON-RPC
 * POST has no single workspace to check. That is also why it is `@ReadKeyOk`:
 * for a read-only key, POST here is transport, not intent.
 */
@ApiTags('mcp')
@Controller('v1/mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly mcp: McpService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @ReadKeyOk()
  @ApiOperation({
    summary: 'MCP Streamable HTTP endpoint (JSON-RPC). Point an MCP client here with a Bearer API key',
  })
  async handle(@CurrentPrincipal() principal: Principal, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { server } = this.mcp.buildServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      this.logger.error({ err: e }, 'MCP request failed');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  }

  // Declared before nothing parameterised, but kept above the 405s anyway so
  // the literal segments read first.
  @Get('connection')
  @ApiOperation({ summary: 'What an MCP client needs to connect: endpoint URL, auth mode, and the tools it would get' })
  connection(@CurrentPrincipal() principal: Principal): McpConnectionInfo {
    return {
      url: this.mcp.publicUrl(),
      serverName: MCP_SERVER_NAME,
      authMode: this.config.get('AUTH_MODE') === 'api-key' ? 'api-key' : 'none',
      version: MCP_SERVER_VERSION,
      tools: this.mcp.toolsFor(principal),
    };
  }

  @Get('skill')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @ApiProduces('text/markdown')
  @ApiOperation({
    summary:
      'SKILL.md for an AI agent using this knowledge base over MCP, generated for the caller (workspaces, projects, offered tools)',
  })
  skill(@CurrentPrincipal() principal: Principal): Promise<string> {
    return this.mcp.skillFor(principal);
  }

  @Get()
  @HttpCode(405)
  @Header('Allow', 'POST')
  @ApiOperation({ summary: 'Not supported: the server is stateless and opens no SSE stream (405, per the MCP spec)' })
  noStream() {
    return methodNotAllowed();
  }

  @Delete()
  @HttpCode(405)
  @Header('Allow', 'POST')
  @ApiOperation({ summary: 'Not supported: there are no sessions to end (405)' })
  noSession() {
    return methodNotAllowed();
  }
}

function methodNotAllowed() {
  return { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null };
}
