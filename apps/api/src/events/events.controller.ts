import { Controller, ParseUUIDPipe, Query, Sse } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { Access } from '../auth/access.decorator.js';
import { EventsSubscriber } from './events.subscriber.js';

@ApiTags('events')
@Controller('v1/events')
export class EventsController {
  constructor(private readonly subscriber: EventsSubscriber) {}

  @Sse()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Live workspace events over SSE (docs/features/04). EventSource cannot set headers — in api-key mode pass ?token=<key>.' })
  @ApiQuery({ name: 'workspaceId', required: true })
  events(@Query('workspaceId', ParseUUIDPipe) workspaceId: string): Observable<{ data: unknown }> {
    return this.subscriber.stream(workspaceId);
  }
}
