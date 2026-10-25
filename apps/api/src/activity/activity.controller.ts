import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { ActivityCalendarResponse, ListActivityResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { ActivityService } from './activity.service.js';
import { t } from '../i18n/t.js';
import { Returns } from '../common/returns.decorator.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest window the calendar will aggregate in one request (~14 months). */
const MAX_CALENDAR_DAYS = 431;

@ApiTags('activity')
@Controller('v1/activity')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly permissions: PermissionService,
  ) {}

  // Declared before @Get() so the literal segment is matched first — house
  // style (see EntitiesController's /trace), not a Nest requirement here.
  @Get('calendar')
  @Returns('ActivityCalendarResponse')
  @Access('viewer', 'query')
  @ApiOperation({
    summary: "One person's activity aggregated per UTC day, for the profile contribution ledger",
  })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'actor', required: true, description: "users.id, or 'dev' in AUTH_MODE=none" })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive YYYY-MM-DD; defaults to 52 weeks before `to`' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive YYYY-MM-DD; defaults to today' })
  async calendar(
    @CurrentPrincipal() principal: Principal,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('actor') actor: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ActivityCalendarResponse> {
    if (!actor) throw new BadRequestException(t('error.activity.actorRequired'));
    // Whole UTC days on both ends: `to` runs to 23:59:59.999 so today's own
    // entries land in today's cell rather than in tomorrow's empty one.
    const end = endOfDay(parseDay(to) ?? new Date());
    const start = startOfDay(parseDay(from) ?? addDays(end, -364));
    if (start > end) throw new BadRequestException(t('error.activity.rangeInverted'));
    if (spanInDays(start, end) > MAX_CALENDAR_DAYS) {
      throw new BadRequestException(t('error.activity.rangeTooWide', { max: MAX_CALENDAR_DAYS }));
    }
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    return this.activity.calendar(workspaceId, { actor, from: start, to: end }, scope);
  }

  @Get()
  @Returns('ListActivityResponse')
  // Guests too: the feed is filtered to rows about pages they can open (#76).
  @Access('viewer', 'query', { guests: true })
  @ApiOperation({ summary: 'Workspace activity feed, newest first (docs/features/10)' })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'documentId', required: false })
  @ApiQuery({ name: 'projectId', required: false, description: 'One project’s feed (docs/features/23) — everything that happened to its pages' })
  @ApiQuery({ name: 'subjectId', required: false, description: 'Secondary subject id — e.g. a merge request id, for its own timeline' })
  @ApiQuery({ name: 'actor', required: false, description: "users.id (or 'dev') — exact match, for one person's feed" })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive YYYY-MM-DD lower bound' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive YYYY-MM-DD upper bound (whole day)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('documentId') documentId?: string,
    @Query('projectId') projectId?: string,
    @Query('subjectId') subjectId?: string,
    @Query('actor') actor?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ListActivityResponse> {
    const fromDate = parseDay(from);
    const toDate = parseDay(to);
    for (const [subject, value] of [['document', documentId], ['project', projectId], ['id', subjectId], ['id', cursor]] as const) {
      if (value && !UUID_RE.test(value)) throw new BadRequestException(t('error.invalidUuid', { subject: t(`subject.${subject}`) }));
    }
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    return this.activity.list(workspaceId, {
      documentId: documentId || undefined,
      projectId: projectId || undefined,
      subjectId: subjectId || undefined,
      actor: actor || undefined,
      from: fromDate ? startOfDay(fromDate) : undefined,
      to: toDate ? endOfDay(toDate) : undefined,
      limit: limit ? Number(limit) : undefined,
      cursor: cursor || undefined,
    }, scope);
  }
}

/** `YYYY-MM-DD` (or any Date-parsable string) → Date; undefined when absent or unparsable. */
function parseDay(value?: string): Date | undefined {
  if (!value) return undefined;
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

function startOfDay(at: Date): Date {
  return new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function endOfDay(at: Date): Date {
  return new Date(`${at.toISOString().slice(0, 10)}T23:59:59.999Z`);
}

function addDays(at: Date, days: number): Date {
  const next = new Date(at);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function spanInDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}
