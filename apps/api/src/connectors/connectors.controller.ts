import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type {
  ConnectorItemEventResponse,
  ConnectorResponse,
  ConnectorRunEventResponse,
  ConnectorRunItemInfo,
  ConnectorRunItemResponse,
  ConnectorRunResponse,
  ConnectorTestResponse,
  ListConnectorLinksResponse,
  ListConnectorRunItemsResponse,
  ListConnectorRunsResponse,
  ListConnectorsResponse,
} from '@knowledge/contracts';
import { ActivityService } from '../activity/activity.service.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ConnectorLinksService } from './connector-links.service.js';
import { ConnectorItemAiService } from './connector-item-ai.service.js';
import { ConnectorItemsService } from './connector-items.service.js';
import { ConnectorProducer } from './connector.producer.js';
import { ConnectorsService, toRunInfo } from './connectors.service.js';
import {
  ConnectorItemAiDto,
  ConnectorItemEventDto,
  ConnectorRunEventDto,
  CreateConnectorDto,
  StartConnectorSyncDto,
  UpdateConnectorDto,
  UpdateConnectorRunItemDto,
} from './connectors.dto.js';

/**
 * Connector administration (docs/features/19).
 *
 * Reads are `viewer`, triggering a sync is `editor`, and anything touching
 * configuration or credentials is `admin` — a connector holds a token that
 * reaches an external system, so editing one is not an ordinary content edit.
 */
@ApiTags('connectors')
@Controller('v1/connectors')
export class ConnectorsController {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly links: ConnectorLinksService,
    private readonly items: ConnectorItemsService,
    private readonly ai: ConnectorItemAiService,
    private readonly producer: ConnectorProducer,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List the connectors configured in a workspace' })
  @ApiQuery({ name: 'workspaceId', required: true })
  async list(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<ListConnectorsResponse> {
    return { workspaceId, connectors: await this.connectors.list(workspaceId) };
  }

  @Post()
  @Access('admin', 'body')
  @ApiOperation({ summary: 'Register a connection to an external system' })
  async create(
    @Body() dto: CreateConnectorDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<ConnectorResponse> {
    const connector = await this.connectors.create(dto, principal?.userId);
    void this.activity.record({
      workspaceId: dto.workspaceId,
      actor: principal?.userId,
      action: 'connector.created',
      subjectId: connector.id,
      metadata: { title: connector.name, kind: connector.kind },
    });
    return { connector };
  }

  /**
   * Declared **before** `@Get(':id')`, or `:id` claims the literal "runs".
   * It lives on its own segment rather than `:id/runs/:runId` because a run id
   * already reaches a connector, so the ACL resolves the workspace from the run.
   */
  @Get('runs/:runId')
  @Access('viewer', 'connector-run')
  @ApiOperation({ summary: 'One sync run — the poll target' })
  async run(@Param('runId', ParseUUIDPipe) runId: string): Promise<ConnectorRunResponse> {
    return { run: await this.items.runInfo(runId) };
  }

  // --- staged items (docs/features/26) ---
  //
  // All under `runs/:runId`, and all declared before `@Get(':id')` for the same
  // reason that route is: Nest matches in declaration order, so `:id` would
  // otherwise swallow the literal "runs".

  @Get('runs/:runId/items')
  @Access('viewer', 'connector-run')
  @ApiOperation({ summary: 'The tree of items this run found — flat rows joined by parentItemId' })
  async listItems(@Param('runId', ParseUUIDPipe) runId: string): Promise<ListConnectorRunItemsResponse> {
    const { items, truncated } = await this.items.listItems(runId);
    return { runId, items, truncated };
  }

  @Get('runs/:runId/items/:itemId')
  @Access('viewer', 'connector-run')
  @ApiOperation({ summary: 'One item with the document it would write, before it writes it' })
  async getItem(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<ConnectorRunItemResponse> {
    return this.items.getItem(runId, itemId);
  }

  @Patch('runs/:runId/items/:itemId')
  @Access('editor', 'connector-run')
  @ApiOperation({ summary: 'Correct a staged item before approving it' })
  async updateItem(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateConnectorRunItemDto,
  ): Promise<{ item: ConnectorRunItemInfo }> {
    return { item: await this.items.updateItem(runId, itemId, dto) };
  }

  @Post('runs/:runId/items/:itemId/ai')
  @Access('editor', 'connector-run')
  @ApiOperation({ summary: 'Ask the drafter to clean up the conversion, or merge it with the current page' })
  async itemAi(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: ConnectorItemAiDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ item: ConnectorRunItemInfo }> {
    return { item: await this.ai.run(runId, itemId, dto.op, principal) };
  }

  @Post('runs/:runId/items/:itemId/events')
  @Access('editor', 'connector-run')
  @ApiOperation({ summary: 'Approve, skip, reject, retry or revert an item — optionally its whole subtree' })
  async itemEvent(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: ConnectorItemEventDto,
  ): Promise<ConnectorItemEventResponse> {
    return this.items.sendItemEvent(runId, itemId, dto.type, dto.subtree ?? false);
  }

  @Post('runs/:runId/events')
  @Access('editor', 'connector-run')
  @ApiOperation({ summary: 'Pause, resume, step, cancel, or approve everything staged' })
  async runEvent(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() dto: ConnectorRunEventDto,
  ): Promise<ConnectorRunEventResponse> {
    return { run: await this.items.sendRunEvent(runId, dto.type) };
  }

  @Get(':id')
  @Access('viewer', 'connector')
  @ApiOperation({ summary: 'Read one connector' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ConnectorResponse> {
    return { connector: await this.connectors.get(id) };
  }

  @Patch(':id')
  @Access('admin', 'connector')
  @ApiOperation({ summary: 'Update a connector; null clears a credential, absent keeps it' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConnectorDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<ConnectorResponse> {
    const connector = await this.connectors.update(id, dto);
    void this.activity.record({
      workspaceId: connector.workspaceId,
      actor: principal?.userId,
      action: 'connector.updated',
      subjectId: connector.id,
      // Never the credential itself — only which fields moved.
      metadata: {
        title: connector.name,
        fields: Object.keys(dto).filter((k) => k !== 'credential' && k !== 'webhookSecret'),
      },
    });
    return { connector };
  }

  @Delete(':id')
  @Access('admin', 'connector')
  @ApiOperation({ summary: 'Delete a connector; the pages it created are kept' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ ok: true }> {
    const connector = await this.connectors.get(id);
    await this.connectors.remove(id);
    void this.activity.record({
      workspaceId: connector.workspaceId,
      actor: principal?.userId,
      action: 'connector.deleted',
      subjectId: id,
      metadata: { title: connector.name },
    });
    return { ok: true };
  }

  @Post(':id/test')
  @Access('admin', 'connector')
  @ApiOperation({ summary: 'Prove the credential and configuration reach the external system' })
  test(@Param('id', ParseUUIDPipe) id: string): Promise<ConnectorTestResponse> {
    return this.connectors.testConnection(id);
  }

  @Post(':id/sync')
  @Access('editor', 'connector')
  @ApiOperation({ summary: 'Start a sync run' })
  async sync(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartConnectorSyncDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<ConnectorRunResponse> {
    const row = await this.connectors.require(id);
    const run = await this.connectors.createRun(row, dto.direction === 'push' ? 'push' : 'pull', 'manual', {
      externalIds: dto.externalIds,
      actorId: principal?.userId,
    });
    await this.producer.enqueue(run.id);
    return { run: toRunInfo(run) };
  }

  @Get(':id/runs')
  @Access('viewer', 'connector')
  @ApiOperation({ summary: 'Recent sync runs, newest first' })
  async runs(@Param('id', ParseUUIDPipe) id: string): Promise<ListConnectorRunsResponse> {
    return { connectorId: id, runs: await this.connectors.listRuns(id) };
  }

  @Get(':id/links')
  @Access('viewer', 'connector')
  @ApiOperation({ summary: 'The external item <-> page identity map' })
  async connectorLinks(@Param('id', ParseUUIDPipe) id: string): Promise<ListConnectorLinksResponse> {
    return { connectorId: id, links: await this.links.listForConnector(id) };
  }

  @Delete(':id/links/:linkId')
  @Access('editor', 'connector')
  @ApiOperation({ summary: 'Stop syncing one page; the page itself is kept' })
  async unlink(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ ok: true }> {
    const connector = await this.connectors.get(id);
    await this.links.remove(linkId);
    void this.activity.record({
      workspaceId: connector.workspaceId,
      actor: principal?.userId,
      action: 'connector.link.removed',
      subjectId: id,
      metadata: { title: connector.name },
    });
    return { ok: true };
  }
}
