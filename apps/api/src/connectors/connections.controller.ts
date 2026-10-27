import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CONNECTOR_KINDS,
  type ConnectionBranchesResponse,
  type ConnectionLinksResponse,
  type ConnectionResourcesResponse,
  type ConnectionResponse,
  type ConnectionsWaitResponse,
  type ConnectorKind,
  type ListConnectionsResponse,
} from '@knowledge/contracts';
import { ActivityService } from '../activity/activity.service.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CachePolicy } from '../common/http-cache.js';
import { Returns } from '../common/returns.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ConnectionsService } from './connections.service.js';
import { CreateConnectionLinksDto, CreateTokenConnectionDto, UpdateConnectionDto } from './connections.dto.js';

/**
 * A workspace's connections (#564): one account's access to an upstream
 * system, and the link screen's reads. Admin throughout — a connection is a
 * credential, and linking creates connectors.
 */
@ApiTags('connections')
@Controller('v1/connections')
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @Returns('ListConnectionsResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: "List the workspace's connections and the connectors using each" })
  @ApiQuery({ name: 'workspaceId', required: true })
  list(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ListConnectionsResponse> {
    return this.connections.list(workspaceId);
  }

  /**
   * The long poll the connect flow holds open while another tab is at the
   * provider (#564). Declared before `:id`. Never stored by anything: the
   * answer is only meaningful at the moment it is given.
   */
  @Get('wait')
  @Returns('ConnectionsWaitResponse')
  @Access('admin', 'query')
  @CachePolicy('no-store')
  @ApiOperation({ summary: 'Answer when connections change, or after about 25 s' })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'since', required: false, description: 'The last fingerprint seen; omit to read the current one at once' })
  wait(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('since') since: string | undefined,
    @Req() req: Request,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<ConnectionsWaitResponse> {
    const gone = new AbortController();
    req.on('close', () => gone.abort());
    return this.connections.wait(workspaceId, principal?.userId ?? null, since?.slice(0, 64), gone.signal);
  }

  @Post()
  @Returns('ConnectionResponse')
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Save a token as a connection; the same account again rotates it' })
  async create(@Body() dto: CreateTokenConnectionDto, @CurrentPrincipal() principal?: Principal): Promise<ConnectionResponse> {
    return { connection: await this.connections.saveToken(dto, principal?.userId ?? null) };
  }

  @Patch(':id')
  @Returns('ConnectionResponse')
  @Access('admin', 'connection')
  @ApiOperation({ summary: "Rotate a token connection's token (same account only)" })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateConnectionDto): Promise<ConnectionResponse> {
    return { connection: await this.connections.rotate(id, dto.credential) };
  }

  @Delete(':id')
  @HttpCode(204)
  @Access('admin', 'connection')
  @ApiOperation({ summary: 'Delete a connection no connector uses (409 names the ones that do)' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.connections.remove(id);
  }

  @Get(':id/resources')
  @Returns('ConnectionResourcesResponse')
  @Access('admin', 'connection')
  @ApiOperation({ summary: 'What this connection can reach for a connector kind, newest activity first' })
  @ApiQuery({ name: 'kind', enum: CONNECTOR_KINDS, required: true })
  @ApiQuery({ name: 'q', required: false })
  resources(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('kind') kind: ConnectorKind,
    @Query('q') q: string | undefined,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<ConnectionResourcesResponse> {
    return this.connections.resources(id, kind, (q ?? '').slice(0, 200), principal?.userId ?? '');
  }

  @Get(':id/branches')
  @Returns('ConnectionBranchesResponse')
  @Access('admin', 'connection')
  @ApiOperation({ summary: "A repository's branches, default first" })
  @ApiQuery({ name: 'repo', required: true, description: 'The resource id: owner/name, or a GitLab project path' })
  branches(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('repo') repo: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<ConnectionBranchesResponse> {
    return this.connections.branches(id, String(repo ?? '').slice(0, 300), principal?.userId ?? '');
  }

  @Post(':id/links')
  @Returns('ConnectionLinksResponse')
  @Access('admin', 'connection')
  @ApiOperation({ summary: 'Link resources to projects: one connector per pair, duplicates reported, never deletes' })
  async link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateConnectionLinksDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<ConnectionLinksResponse> {
    const results = await this.connections.link(id, dto, principal?.userId ?? null);
    const connection = await this.connections.require(id);
    for (const r of results) {
      if (r.status !== 'created' || !r.connectorId) continue;
      void this.activity.record({
        workspaceId: connection.workspaceId,
        actor: principal?.userId,
        action: 'connector.created',
        subjectId: r.connectorId,
        metadata: { title: r.label, kind: r.kind },
      });
    }
    return { results };
  }
}
