import { Controller, Delete, Get, Header, Headers, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { CurrentPrincipal, ReadKeyOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CachePolicy } from '../common/http-cache.js';
import { MemoryAccessService } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';
import { MemoryIntakeService } from './memory-intake.service.js';
import { buildMemoryMcpServer, type MemoryMcpServices } from './memory-mcp.js';
import { MemoryRecallService } from './memory-recall.service.js';
import { MemoryReflectService } from './memory-reflect.service.js';

const methodNotAllowed = () => ({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });

/**
 * MCP over Streamable HTTP for a memory bank (#986 phase 5), at Hindsight's
 * paths: `POST mcp/{bank_id}/` for one bank, `POST mcp` with an `X-Bank-Id`
 * header. Production forwards `/api/*` here, so a client is given
 * `https://<host>/api/mcp/{bank_id}/`.
 *
 * Stateless, as the platform's own endpoint is: each POST builds a server for
 * that request's principal and throws it away, and GET and DELETE answer 405.
 *
 * Before a server is built the request is resolved as a viewer's: with memory
 * off on the server or in the workspace this is a 404, for a key with no
 * workspace pin a 400. Each tool then resolves again for what it does, on
 * execution. `@ReadKeyOk` because POST is transport here; **not** `@McpKeyOk`,
 * so a key limited to toolsets stays refused by `AuthGuard` — its list names
 * the platform's toolsets and narrows nothing in this server.
 */
@ApiExcludeController()
@CachePolicy('no-store')
@ReadKeyOk()
@Controller('mcp')
export class MemoryMcpController {
  private readonly logger = new Logger(MemoryMcpController.name);
  private readonly services: MemoryMcpServices;

  constructor(access: MemoryAccessService, banks: MemoryBanksService, intake: MemoryIntakeService, recall: MemoryRecallService, reflect: MemoryReflectService) {
    this.services = { access, banks, intake, recall, reflect };
  }

  @Post()
  header(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') workspaceHeader: string | undefined,
    @Headers('x-bank-id') headerBank: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.handle({ principal, workspaceHeader, pathBank: null, headerBank }, req, res);
  }

  @Post(':bankId')
  bank(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') workspaceHeader: string | undefined,
    @Param('bankId') pathBank: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.handle({ principal, workspaceHeader, pathBank, headerBank: undefined }, req, res);
  }

  private async handle(request: Parameters<typeof buildMemoryMcpServer>[1], req: Request, res: Response): Promise<void> {
    // Thrown before `res` is touched, so the exception filter answers it in the memory error shape.
    await this.services.access.caller(request.principal, request.workspaceHeader, 'viewer');
    const server = buildMemoryMcpServer(this.services, request);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      this.logger.error({ err: e }, 'Memory MCP request failed');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }

  // GET (an SSE stream) and DELETE (a session) have nothing to act on in a
  // stateless server. With memory off they are 404 like the rest, so a server
  // without memory answers these paths exactly as it did before they existed.
  @Get(['', ':bankId'])
  @HttpCode(405)
  @Header('Allow', 'POST')
  noStream() {
    this.services.access.requireEnabled();
    return methodNotAllowed();
  }

  @Delete(['', ':bankId'])
  @HttpCode(405)
  @Header('Allow', 'POST')
  noSession() {
    this.services.access.requireEnabled();
    return methodNotAllowed();
  }
}
