import { Controller, Query, Sse } from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { concatMap, filter, interval, takeUntil, type Observable } from 'rxjs';
import { Access, CurrentPrincipal, QueryTokenOk } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { EventsSubscriber } from './events.subscriber.js';
import { LiveVisibility } from './live-visibility.js';
import { AccessService } from '../auth/access.service.js';
import { TokenAuthService } from '../auth/token-auth.service.js';
import { LIVE_RECHECK_MS, liveStanding } from './live-recheck.js';

@ApiTags('events')
@Controller('v1/events')
export class EventsController {
  constructor(
    private readonly subscriber: EventsSubscriber,
    private readonly visibility: LiveVisibility,
    private readonly tokenAuth: TokenAuthService,
    private readonly access: AccessService,
  ) {}

  @Sse()
  @Access('viewer', 'query')
  @QueryTokenOk() // EventSource cannot set headers
  @ApiOperation({ summary: 'Live workspace events over SSE (docs/features/04). EventSource cannot set headers — in api-key mode pass ?token=<kt_ ticket> from POST /v1/auth/url-ticket (API keys are refused in URLs).' })
  @ApiQuery({ name: 'workspaceId', required: true })
  events(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Observable<{ data: unknown }> {
    // The principal is passed so addressed frames (notification.created) reach
    // only their recipient, and frames about a page only those who can open it
    // (#76) — see EventsSubscriber.stream.
    const stream = this.subscriber.stream(workspaceId, principal, async (event) => {
      this.visibility.observe(event);
      if (!principal) return !event.documentId;
      return (await this.visibility.allows(event, [principal]))[0];
    });
    // Re-judged while open (#1097): once the credential or the membership is
    // gone the stream ends, and EventSource's reconnect has to authenticate anew.
    const revoked = interval(LIVE_RECHECK_MS).pipe(
      concatMap(() => liveStanding(this.tokenAuth, this.access, principal, workspaceId)),
      filter((standing) => standing !== 'ok'),
    );
    return stream.pipe(takeUntil(revoked));
  }
}
