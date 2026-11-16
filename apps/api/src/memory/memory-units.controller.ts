import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { ApiExcludeController } from '@nestjs/swagger';
import { CurrentPrincipal, ReadKeyOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { CachePolicy } from '../common/http-cache.js';
import { MemoryAccessService } from './memory-access.service.js';
import { MemoryDirectivesService } from './memory-directives.service.js';
import {
  MemoryFilesService,
  type MemoryToolResult,
} from './memory-files.service.js';
import { MemoryIntakeService } from './memory-intake.service.js';
import { MemoryManagementService } from './memory-management.service.js';
import { MemoryMentalModelsService } from './memory-mental-models.service.js';
import { MemoryOperationsService } from './memory-operations.service.js';
import { MemoryRateService } from './memory-rate.service.js';
import { recallQuery, reflectQuery } from './memory-queries.js';
import { MemoryRecallService } from './memory-recall.service.js';
import { MemoryReflectService } from './memory-reflect.service.js';
import { MemoryUnitsService } from './memory-units.service.js';
import { MemoryUploadGuard } from './memory-upload.guard.js';
import {
  AuditLogStatsQueryDto,
  ClearMemoriesQueryDto,
  ConsolidateDto,
  CreateBankAliasDto,
  CreateDirectiveDto,
  CreateMentalModelDto,
  GetMentalModelQueryDto,
  ImportBankTemplateDto,
  ListAuditLogsQueryDto,
  ListDirectivesQueryDto,
  ListDocumentsQueryDto,
  ListMemoriesQueryDto,
  ListMentalModelsQueryDto,
  ListObservationScopesQueryDto,
  ListOperationsQueryDto,
  ListTagsQueryDto,
  RecallDto,
  ReflectDto,
  RefreshMentalModelDto,
  RetainDto,
  SetBankAliasPrimaryDto,
  TransferQueryDto,
  UpdateDirectiveDto,
  UpdateDocumentDto,
  UpdateMentalModelDto,
} from './memory.dto.js';
import type {
  BankStatsResponse,
  CancelOperationResponse,
  ConsolidationResponse,
  CreateMentalModelResponse,
  DeleteResponse,
  DirectiveListResponse,
  DirectiveResponse,
  ListMemoryUnitsResponse,
  MentalModelHistoryResponse,
  MentalModelListResponse,
  MentalModelResponse,
  OperationStatusResponse,
  OperationsListResponse,
  RecallResponse,
  ReflectResponse,
  RetainResponse,
} from './memory-wire.js';

/**
 * What a bank holds, in Hindsight's wire shape: retain/recall/reflect,
 * documents, observations, operations and the phase-6 management routes. Every
 * handler resolves through `MemoryAccessService`, as the bank routes do.
 */
@ApiExcludeController()
@CachePolicy('no-store')
@ReadKeyOk()
@Controller('v1/default/banks/:bankId')
export class MemoryUnitsController {
  constructor(
    private readonly access: MemoryAccessService,
    private readonly intake: MemoryIntakeService,
    private readonly units: MemoryUnitsService,
    private readonly recaller: MemoryRecallService,
    private readonly operations: MemoryOperationsService,
    private readonly reflector: MemoryReflectService,
    private readonly directives: MemoryDirectivesService,
    private readonly mentalModels: MemoryMentalModelsService,
    private readonly rate: MemoryRateService,
    private readonly files: MemoryFilesService,
    private readonly management: MemoryManagementService,
  ) {}

  /**
   * Retain. An editor's call, and the one a `capture` key is lifted for. The
   * bank is created on a first retain. Sync: every item is stored before this
   * answers. `async: true`: the items are stored masked in an operation row,
   * the worker retains them, and this answers at once with the operation's id.
   */
  @Post('memories')
  @HttpCode(200)
  async retain(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Body() dto: RetainDto,
  ): Promise<RetainResponse> {
    return this.intake.retain(
      await this.access.caller(principal, ws, 'editor', { capture: true }),
      bankId,
      dto,
    );
  }

  /**
   * The Anthropic memory tool's storage (#1009): the raw `tool_use.input` of
   * `memory_20250818` in, the `tool_result` out, so an SDK handler is one
   * HTTP call. A refused path or a missing file is `is_error: true` with a 200;
   * memory off, a missing role or a spent rate is an HTTP error. The role is
   * the command's: `view` a viewer, `create` an editor or a capture key, the
   * rest an editor.
   */
  @Post('memory-tool')
  @HttpCode(200)
  memoryTool(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Body() input: Record<string, unknown>,
  ): Promise<MemoryToolResult> {
    return this.files.execute(
      (role, opts) => this.access.caller(principal, ws, role, opts),
      bankId,
      input,
    );
  }

  /** Recall. A viewer's call; the bank is resolved — and a missing or hidden one refused — before anything is embedded. */
  @Post('memories/recall')
  @HttpCode(200)
  async recall(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Body() dto: RecallDto,
  ): Promise<RecallResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    const bank = await this.access.bank(caller, bankId);
    await this.rate.check('recall', principal);
    return this.recaller.recall(bank, recallQuery(dto, principal.userId));
  }

  /** Reflect: an initial recall, then a bounded recall-and-answer loop. A viewer's call, like the recall it starts with. */
  @Post('reflect')
  @HttpCode(200)
  async reflect(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Body() dto: ReflectDto,
  ): Promise<ReflectResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    const bank = await this.access.bank(caller, bankId);
    await this.rate.check('reflect', principal);
    return this.reflector.reflect(bank, reflectQuery(dto, principal));
  }

  @Get('mental-models')
  async listMentalModels(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: ListMentalModelsQueryDto,
  ): Promise<MentalModelListResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.mentalModels.list(await this.access.bank(caller, bankId), query);
  }

  @Post('mental-models')
  @HttpCode(200)
  async createMentalModel(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Body() dto: CreateMentalModelDto,
  ): Promise<CreateMentalModelResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.mentalModels.create(await this.access.bank(caller, bankId), dto, principal.userId, principal.locale);
  }

  @Get('mental-models/:mentalModelId/history')
  async mentalModelHistory(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('mentalModelId') id: string,
  ): Promise<MentalModelHistoryResponse[]> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.mentalModels.historyList(await this.access.bank(caller, bankId), id);
  }

  @Post('mental-models/:mentalModelId/refresh')
  @HttpCode(200)
  async refreshMentalModel(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('mentalModelId') id: string,
    @Body() dto: RefreshMentalModelDto = {},
  ): Promise<{ operation_id: string; status: string }> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.mentalModels.refresh(await this.access.bank(caller, bankId), id, dto, principal.userId, principal.locale);
  }

  @Post('mental-models/:mentalModelId/clear')
  @HttpCode(200)
  async clearMentalModel(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('mentalModelId') id: string,
  ): Promise<MentalModelResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.mentalModels.clear(await this.access.bank(caller, bankId), id);
  }

  @Get('mental-models/:mentalModelId')
  async getMentalModel(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('mentalModelId') id: string,
    @Query() query: GetMentalModelQueryDto,
  ): Promise<MentalModelResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.mentalModels.get(await this.access.bank(caller, bankId), id, query.detail);
  }

  @Patch('mental-models/:mentalModelId')
  async updateMentalModel(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('mentalModelId') id: string,
    @Body() dto: UpdateMentalModelDto,
  ): Promise<MentalModelResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.mentalModels.update(await this.access.bank(caller, bankId), id, dto);
  }

  @Delete('mental-models/:mentalModelId')
  async deleteMentalModel(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('mentalModelId') id: string,
  ): Promise<void> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.mentalModels.delete(await this.access.bank(caller, bankId), id);
  }

  @Get('directives')
  async listDirectives(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: ListDirectivesQueryDto,
  ): Promise<DirectiveListResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.directives.list(await this.access.bank(caller, bankId), query);
  }

  @Post('directives')
  @HttpCode(200)
  async createDirective(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Body() dto: CreateDirectiveDto,
  ): Promise<DirectiveResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.directives.create(await this.access.bank(caller, bankId), dto);
  }

  @Get('directives/:directiveId')
  async getDirective(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('directiveId') directiveId: string,
  ): Promise<DirectiveResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.directives.get(
      await this.access.bank(caller, bankId),
      directiveId,
    );
  }

  @Patch('directives/:directiveId')
  async updateDirective(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('directiveId') directiveId: string,
    @Body() dto: UpdateDirectiveDto,
  ): Promise<DirectiveResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.directives.update(
      await this.access.bank(caller, bankId),
      directiveId,
      dto,
    );
  }

  @Delete('directives/:directiveId')
  async deleteDirective(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('directiveId') directiveId: string,
  ): Promise<DeleteResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.directives.delete(
      await this.access.bank(caller, bankId),
      directiveId,
    );
  }

  /** One consolidation pass, optionally only for memories matching a requested tag scope. */
  @Post('consolidate')
  @HttpCode(200)
  async consolidate(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Body() dto: ConsolidateDto = {},
  ): Promise<ConsolidationResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.operations.consolidate(await this.access.bank(caller, bankId), {
      userId: principal.userId,
      locale: principal.locale,
      observationScopes: dto.observation_scopes,
    });
  }

  @Get('observations/scopes')
  async observationScopes(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: ListObservationScopesQueryDto,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.observationScopes(await this.access.bank(caller, bankId), query);
  }

  @Get('documents')
  async documents(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: ListDocumentsQueryDto,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.documents(await this.access.bank(caller, bankId), query);
  }

  @Get('documents/:documentId/chunks')
  async documentChunks(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('documentId') documentId: string,
    @Query() query: ListObservationScopesQueryDto,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.chunks(await this.access.bank(caller, bankId), documentId, query);
  }

  @Get('documents/:documentId')
  async document(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('documentId') documentId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.document(await this.access.bank(caller, bankId), documentId);
  }

  @Patch('documents/:documentId')
  async updateDocument(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('documentId') documentId: string,
    @Body() dto: UpdateDocumentDto,
  ): Promise<{ success: true }> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.units.updateDocument(await this.access.bank(caller, bankId), documentId, dto);
  }

  @Delete('documents/:documentId')
  async deleteDocument(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('documentId') documentId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.units.deleteDocument(await this.access.bank(caller, bankId), documentId);
  }

  @Get('tags')
  async tags(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: ListTagsQueryDto,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.tags(await this.access.bank(caller, bankId), query);
  }

  @Delete('observations')
  async clearObservations(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.units.clearObservations(await this.access.bank(caller, bankId));
  }

  @Delete('memories/:memoryId/observations')
  async clearMemoryObservations(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('memoryId') memoryId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.units.clearObservations(await this.access.bank(caller, bankId), memoryId);
  }

  @Get('memories/:memoryId/history')
  async observationHistory(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('memoryId') memoryId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.observationHistory(await this.access.bank(caller, bankId), memoryId);
  }

  @Get('aliases')
  async aliases(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.management.aliases(await this.access.bank(caller, bankId));
  }

  @Post('aliases')
  async createAlias(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Body() dto: CreateBankAliasDto,
  ) {
    return this.management.createAlias(await this.access.caller(principal, ws, 'editor'), bankId, dto);
  }

  @Delete('aliases/:alias')
  async deleteAlias(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('alias') alias: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.management.deleteAlias(await this.access.bank(caller, bankId), alias);
  }

  @Patch('aliases/:alias')
  async setAliasPrimary(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('alias') alias: string,
    @Body() dto: SetBankAliasPrimaryDto,
  ) {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.management.setAliasPrimary(await this.access.bank(caller, bankId), alias, dto);
  }

  @Get('export')
  async exportTemplate(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.management.exportTemplate(await this.access.bank(caller, bankId));
  }

  @Post('import')
  @HttpCode(200)
  async importTemplate(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Body() dto: ImportBankTemplateDto,
    @Query('dry_run') dryRun: string | undefined,
  ) {
    return this.management.importTemplate(await this.access.caller(principal, ws, 'editor'), bankId, dto, dryRun === 'true');
  }

  @Post('files/retain')
  @HttpCode(200)
  @UseGuards(MemoryUploadGuard)
  @UseInterceptors(AnyFilesInterceptor({ limits: { files: 100, fileSize: 16 * 1024 * 1024 } }))
  async retainFiles(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @UploadedFiles() files: Array<{ originalname: string; mimetype: string; buffer: Buffer; size: number }>,
    @Body('request') request: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'editor');
    // Here, not in the service: the limiter is the API's, and the worker loads the management service too.
    await this.rate.check('retain', principal);
    return this.management.submitFiles(caller, bankId, files ?? [], request);
  }

  @Post('document-transfer/export')
  @HttpCode(202)
  async exportDocuments(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: TransferQueryDto,
  ) {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.management.submitExport(await this.access.bank(caller, bankId), query, false, principal.userId, principal.locale);
  }

  @Post('transfer/export')
  @HttpCode(202)
  async exportBank(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: TransferQueryDto,
  ) {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.management.submitExport(await this.access.bank(caller, bankId), query, true, principal.userId, principal.locale);
  }

  @Post('document-transfer')
  @UseGuards(MemoryUploadGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 64 * 1024 * 1024 } }))
  async importDocuments(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
    @Query() query: TransferQueryDto,
  ) {
    return this.management.submitImport(await this.access.caller(principal, ws, 'editor'), bankId, file, query, true);
  }

  @Post('transfer/import')
  @UseGuards(MemoryUploadGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 64 * 1024 * 1024 } }))
  async importBank(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
    @Query() query: TransferQueryDto,
  ) {
    return this.management.submitImport(await this.access.caller(principal, ws, 'editor'), bankId, file, query, false);
  }

  @Post('clone')
  @HttpCode(200)
  async cloneBank(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: TransferQueryDto,
  ) {
    return this.management.submitClone(await this.access.caller(principal, ws, 'editor'), bankId, query);
  }

  @Get('audit-logs/stats')
  async auditStats(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: AuditLogStatsQueryDto,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.management.auditStats(await this.access.bank(caller, bankId), query);
  }

  @Get('audit-logs/:logId')
  async auditLog(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('logId') logId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.management.auditLog(await this.access.bank(caller, bankId), logId);
  }

  @Get('audit-logs')
  async auditLogs(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: ListAuditLogsQueryDto,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.management.auditLogs(await this.access.bank(caller, bankId), query);
  }

  @Get('memories/list')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: ListMemoriesQueryDto,
  ): Promise<ListMemoryUnitsResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.list(await this.access.bank(caller, bankId), query);
  }

  @Get('memories/:memoryId')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('memoryId') memoryId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.units.get(await this.access.bank(caller, bankId), memoryId);
  }

  @Delete('memories')
  async clear(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: ClearMemoriesQueryDto,
  ): Promise<DeleteResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.units.clear(await this.access.bank(caller, bankId), query.type);
  }

  @Get('stats')
  async stats(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
  ): Promise<BankStatsResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    const bank = await this.access.bank(caller, bankId);
    const [stats, operations] = await Promise.all([
      this.units.stats(bank),
      this.operations.counts(bank.id),
    ]);
    return {
      ...stats,
      pending_operations: operations.pending,
      failed_operations: operations.failed,
    };
  }

  @Get('operations')
  async listOperations(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Query() query: ListOperationsQueryDto,
  ): Promise<OperationsListResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.operations.list(await this.access.bank(caller, bankId), query);
  }

  @Get('operations/:operationId')
  async operationStatus(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('operationId') operationId: string,
  ): Promise<OperationStatusResponse> {
    const caller = await this.access.caller(principal, ws, 'viewer');
    return this.operations.status(
      await this.access.bank(caller, bankId),
      operationId,
    );
  }

  /** Cancel a pending operation. A write key's call: a `capture` key retains and nothing more. */
  @Delete('operations/:operationId')
  async cancelOperation(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('operationId') operationId: string,
  ): Promise<CancelOperationResponse> {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.operations.cancel(
      await this.access.bank(caller, bankId),
      operationId,
    );
  }

  @Delete('operations/:operationId/delete')
  async deleteOperation(
    @CurrentPrincipal() principal: Principal,
    @Headers('x-workspace-id') ws: string | undefined,
    @Param('bankId') bankId: string,
    @Param('operationId') operationId: string,
  ) {
    const caller = await this.access.caller(principal, ws, 'editor');
    return this.operations.delete(await this.access.bank(caller, bankId), operationId);
  }
}
