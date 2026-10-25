import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { publicSiteSessionPath, type SiteSignInResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { t } from '../i18n/t.js';
import { SiteSignInDto } from '../publishing/sites.dto.js';
import { PublicSitesService } from './public-sites.service.js';
import { SiteSessionService } from './site-session.service.js';
import { Returns } from '../common/returns.decorator.js';

/** The prefix the front proxy (Caddy, or Vite in dev) strips before the API, on the app's origin and on every site host. */
const API_PREFIX = '/api';

/**
 * The member half of site sign-in (issue #77 phase 3, docs/features/44).
 *
 * A site lives on its own origin, which never sees the app's session, so a
 * member proves who they are to the app and the app hands the site a one-time
 * code: the app page `/site-sign-in` posts here, and sends the browser to the
 * URL this answers — the site's own session route, on the origin the reader
 * was on, which spends the code and sets the site's cookie there.
 *
 * Any role in the workspace is enough: a member can read every page in the
 * app already. The return address must be one of the site's own, so this
 * cannot be turned into a redirect to anywhere else.
 */
@ApiTags('publishing')
@Controller('v1/sites')
export class SiteSignInController {
  constructor(
    private readonly sites: PublicSitesService,
    private readonly sessions: SiteSessionService,
  ) {}

  @Post(':id/sign-in')
  @Returns('SiteSignInResponse')
  @Access('viewer', 'site')
  @ApiOperation({ summary: 'A one-time sign-in to a live site for the calling member: the URL to send the browser to' })
  @ApiResponse({ status: 400, description: 'The return URL is not on one of the site’s addresses (details.reason site.signInReturnInvalid)' })
  @ApiResponse({ status: 404, description: 'No live site with this id' })
  async signIn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SiteSignInDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SiteSignInResponse> {
    const site = await this.sites.findById(id);
    const target = this.sites.siteAddress(site, dto.returnUrl);
    if (!target) {
      throw new BadRequestException({ statusCode: 400, message: t('error.site.signInReturnInvalid'), reason: 'site.signInReturnInvalid' });
    }
    const code = await this.sessions.issueCode(site.id, principal?.userId ?? '00000000-0000-0000-0000-000000000000');
    const query = new URLSearchParams({ code, return: target.path });
    return { url: `${target.origin}${API_PREFIX}${publicSiteSessionPath(site.id)}?${query}` };
  }
}
