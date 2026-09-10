import { Controller, Query, Sse } from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { EventsSubscriber } from './events.subscriber.js';

@ApiTags('events')
@Controller('v1/events')
export class EventsController {
  constructor(private readonly subscriber: EventsSubscriber) {}

  @Sse()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Live workspace events over SSE (docs/features/04). EventSource cannot set headers — in api-key mode pass ?token=<key>.' })
  @ApiQuery({ name: 'workspaceId', required: true })
  events(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Observable<{ data: unknown }> {
    // The principal is passed so addressed frames (notification.created) reach
    // only their recipient — see EventsSubscriber.stream.
    return this.subscriber.stream(workspaceId, principal?.userId);
  }
}
