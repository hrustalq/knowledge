import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { parseEmbedUrl, type EmbedUsagesResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { PermissionService } from '../permissions/permission.service.js';
import { EmbedUsagesQueryDto, EmbedUsagesResponseDto } from './embeds.dto.js';
import { EmbedsService } from './embeds.service.js';
import { Returns } from '../common/returns.decorator.js';

/** The REST twin of `knowledge_find_embeds` (#470): which pages embed a Figma file or frame. */
@ApiTags('embeds')
@Controller('v1/embeds/usages')
export class EmbedUsagesController {
  constructor(
    private readonly embeds: EmbedsService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @Returns('EmbedUsagesResponse')
  // Guests too: the scope below returns only pages they were granted (#76).
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({ summary: 'Pages whose current version embeds a Figma file or frame' })
  @ApiOkResponse({ type: EmbedUsagesResponseDto })
  async usages(@Query() query: EmbedUsagesQueryDto, @CurrentPrincipal() principal: Principal): Promise<EmbedUsagesResponse> {
    const ref = query.figmaUrl ? parseEmbedUrl(query.figmaUrl) : null;
    if (query.figmaUrl && !ref) throw new BadRequestException(t('error.embed.notFigma'));
    const fileKey = ref?.fileKey ?? query.fileKey;
    if (!fileKey) throw new BadRequestException(t('error.embed.notFigma'));
    const scope = await this.permissions.scopeFor(principal, query.workspaceId);
    return { pages: await this.embeds.usages(scope, { fileKey, nodeId: ref?.nodeId ?? undefined }) };
  }
}
