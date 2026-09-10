import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SUBJECT_TYPES,
  SUBSCRIPTION_STATES,
  type NotificationCategory,
  type NotificationSubjectType,
  type SubscriptionState,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

/** Mirrors UUID_RE in acl.guard.ts (any version digit, nil allowed). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nobody has a thousand unread rows worth clearing one id at a time. */
const MAX_MARK_IDS = 200;

export class MarkNotificationsReadDto {
  // Field name must stay `workspaceId`: @Access('viewer','body') resolves it.
  @ApiProperty()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Specific rows to mark read. Omit and pass `all` to clear the workspace.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MARK_IDS, { message: vmsg('arrayMaxSize') })
  @Matches(UUID_RE, { each: true })
  ids?: string[];

  @ApiPropertyOptional({ description: 'Mark every unread row read. Defaults to false.' })
  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @ApiPropertyOptional({
    enum: NOTIFICATION_CATEGORIES,
    description: 'Narrows `all` to one category, so clearing comments leaves reviews unread.',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_CATEGORIES as readonly string[], { message: vmsg('isIn') })
  category?: NotificationCategory;
}

export class SetNotificationSubscriptionDto {
  @ApiProperty()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiProperty({ enum: NOTIFICATION_SUBJECT_TYPES })
  @IsIn(NOTIFICATION_SUBJECT_TYPES as readonly string[], { message: vmsg('isIn') })
  subjectType!: NotificationSubjectType;

  @ApiProperty()
  @Matches(UUID_RE)
  subjectId!: string;

  @ApiProperty({
    enum: SUBSCRIPTION_STATES,
    description:
      "'watching' or 'muted' store a row; 'default' removes it, so involvement may subscribe you again later.",
  })
  @IsIn(SUBSCRIPTION_STATES as readonly string[], { message: vmsg('isIn') })
  state!: SubscriptionState;
}

export class UpdateNotificationPreferencesDto {
  @ApiProperty()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiPropertyOptional({
    enum: NOTIFICATION_CATEGORIES,
    isArray: true,
    description: 'Categories to switch off; omit to leave unchanged. An empty array clears every mute.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NOTIFICATION_CATEGORIES.length, { message: vmsg('arrayMaxSize') })
  @IsIn(NOTIFICATION_CATEGORIES as readonly string[], { each: true, message: vmsg('isIn') })
  mutedCategories?: NotificationCategory[];

  @ApiPropertyOptional({
    description: 'Commenting on something starts watching it. Defaults to true; omit to leave unchanged.',
  })
  @IsOptional()
  @IsBoolean()
  autoWatchOnComment?: boolean;
}

/** Query params shared by the list and unread-count reads. */
export class ListNotificationsQueryDto {
  @ApiProperty()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiPropertyOptional({ description: 'Only unread rows. Defaults to false.' })
  @IsOptional()
  // Query strings carry 'true'/'false', not booleans, and @IsBoolean would
  // reject both before the service ever saw them.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({ enum: NOTIFICATION_CATEGORIES })
  @IsOptional()
  @IsIn(NOTIFICATION_CATEGORIES as readonly string[], { message: vmsg('isIn') })
  category?: NotificationCategory;

  @ApiPropertyOptional({ description: 'Page size, 1-100. Defaults to 30.' })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;
}
