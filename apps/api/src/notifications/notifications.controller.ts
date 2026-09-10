import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type {
  ListNotificationSubscriptionsResponse,
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
  NotificationPreferences,
  NotificationSubjectType,
  NotificationUnreadCountResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import {
  ListNotificationsQueryDto,
  MarkNotificationsReadDto,
  SetNotificationSubscriptionDto,
  UpdateNotificationPreferencesDto,
} from './notifications.dto.js';
import { NotificationsService } from './notifications.service.js';

/**
 * The caller's own inbox (docs/features/22).
 *
 * Every route is `viewer`: whoever may read a workspace may be told about it,
 * and there is nothing here an editor can do that a reader cannot. The ACL
 * resolves from `workspaceId` in the query or body, so no new `WorkspaceSource`
 * was needed — and there is no route that takes somebody else's id, because
 * every read and write is scoped to `principal.userId` inside the service.
 * That is the `SavedFiltersService` stance: the guard knows workspaces, rows
 * are owned, and an inbox is nobody else's business.
 */
@ApiTags('notifications')
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // Literal segments before any parameterised route — house style.

  @Get('unread-count')
  @Access('viewer', 'query')
  @ApiOperation({
    summary: "Unread totals for the caller, overall and per category — the bell's badge",
  })
  @ApiQuery({ name: 'workspaceId', required: true })
  unreadCount(
    @Query('workspaceId') workspaceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationUnreadCountResponse> {
    return this.notifications.unreadCount(workspaceId, principal.userId);
  }

  @Get('subscriptions')
  @Access('viewer', 'query')
  @ApiOperation({
    summary:
      "What the caller watches. Pass subjectType+subjectId to ask about one thing (the Watch button's state)",
  })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'subjectType', required: false, enum: ['document', 'merge-request', 'project'] })
  @ApiQuery({ name: 'subjectId', required: false })
  listSubscriptions(
    @Query('workspaceId') workspaceId: string,
    @CurrentPrincipal() principal: Principal,
    @Query('subjectType') subjectType?: NotificationSubjectType,
    @Query('subjectId') subjectId?: string,
  ): Promise<ListNotificationSubscriptionsResponse> {
    return this.notifications.listSubscriptions(workspaceId, principal.userId, {
      subjectType: subjectType || undefined,
      subjectId: subjectId || undefined,
    });
  }

  @Put('subscriptions')
  @Access('viewer', 'body')
  @ApiOperation({
    summary:
      "Watch, mute or forget one subject. 'muted' is stored so involvement cannot re-subscribe you; 'default' removes the row (400 when the subject belongs to another workspace)",
  })
  setSubscription(
    @Body() dto: SetNotificationSubscriptionDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ListNotificationSubscriptionsResponse> {
    return this.notifications.setSubscription(
      dto.workspaceId,
      principal.userId,
      dto.subjectType,
      dto.subjectId,
      dto.state,
    );
  }

  @Get('preferences')
  @Access('viewer', 'query')
  @ApiOperation({
    summary: "The caller's notification preferences, with the code defaults folded in",
  })
  @ApiQuery({ name: 'workspaceId', required: true })
  preferences(
    @Query('workspaceId') workspaceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationPreferences> {
    return this.notifications.preferences(workspaceId, principal.userId);
  }

  @Put('preferences')
  @Access('viewer', 'body')
  @ApiOperation({ summary: "Mute categories, or stop auto-watching what the caller comments on" })
  updatePreferences(
    @Body() dto: UpdateNotificationPreferencesDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationPreferences> {
    return this.notifications.updatePreferences(dto.workspaceId, principal.userId, {
      mutedCategories: dto.mutedCategories,
      autoWatchOnComment: dto.autoWatchOnComment,
    });
  }

  @Post('read')
  @HttpCode(200)
  @Access('viewer', 'body')
  @ApiOperation({
    summary:
      'Mark rows read — `ids` for a set, `all` for the workspace, optionally narrowed to one category (400 when neither is given)',
  })
  markRead(
    @Body() dto: MarkNotificationsReadDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MarkNotificationsReadResponse> {
    return this.notifications.markRead(dto.workspaceId, principal.userId, {
      ids: dto.ids,
      all: dto.all,
      category: dto.category,
    });
  }

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({
    summary: "The caller's inbox, newest first. Coalesced rows carry metadata.count (docs/features/22)",
  })
  list(
    @Query() query: ListNotificationsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ListNotificationsResponse> {
    return this.notifications.list(query.workspaceId, principal.userId, {
      unread: query.unread,
      category: query.category,
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}
