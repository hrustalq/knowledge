import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  ACCESS_LEVELS,
  ACCESS_REQUEST_STATUSES,
  ACCESS_RESOURCE_TYPES,
  ACCESS_SUBJECT_TYPES,
  REQUESTABLE_ACCESS_LEVELS,
  type AccessLevel,
  type AccessRequestStatus,
  type AccessResourceType,
  type AccessSubjectType,
  type RequestableAccessLevel,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

/** Mirrors UUID_RE in acl.guard.ts (any version digit, nil allowed). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A group name is a label in a picker and on a grant row, not a sentence. */
const MAX_GROUP_NAME_CHARS = 80;
const MAX_GROUP_DESCRIPTION_CHARS = 500;
/** One save of the member picker; a larger roster is several saves. */
const MAX_MEMBER_CHANGES = 200;

export class ListUserGroupsQueryDto {
  // Field name must stay `workspaceId`: @Access('viewer','query') resolves it.
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;
}

export class CreateUserGroupDto {
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiProperty({ example: 'Security team' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_GROUP_NAME_CHARS, { message: vmsg('maxLength') })
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_GROUP_DESCRIPTION_CHARS, { message: vmsg('maxLength') })
  description?: string | null;
}

export class UpdateUserGroupDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_GROUP_NAME_CHARS, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Empty or null clears it' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_GROUP_DESCRIPTION_CHARS, { message: vmsg('maxLength') })
  description?: string | null;
}

export class UpdateUserGroupMembersDto {
  @ApiPropertyOptional({ type: [String], description: 'User ids to add; each must be a member of the workspace' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEMBER_CHANGES, { message: vmsg('arrayMaxSize') })
  @Matches(UUID_RE, { each: true })
  add?: string[];

  @ApiPropertyOptional({ type: [String], description: 'User ids to remove; an id that is not in the group is ignored' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEMBER_CHANGES, { message: vmsg('arrayMaxSize') })
  @Matches(UUID_RE, { each: true })
  remove?: string[];
}

/** One save of the access dialog; a page with more grantees than this wants a group. */
const MAX_GRANTS = 200;

export class AccessGrantInputDto {
  @ApiProperty({ enum: ACCESS_SUBJECT_TYPES })
  @IsIn(ACCESS_SUBJECT_TYPES)
  subjectType!: AccessSubjectType;

  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  subjectId!: string;

  @ApiProperty({ enum: ACCESS_LEVELS })
  @IsIn(ACCESS_LEVELS)
  level!: AccessLevel;
}

export class UpdateResourceAccessDto {
  @ApiProperty({ description: 'On: only grantees (and workspace admins) open this node and everything under it' })
  @IsBoolean()
  restricted!: boolean;

  @ApiProperty({ type: [AccessGrantInputDto], description: "Replaces the node's manual grants as a whole" })
  @IsArray()
  @ArrayMaxSize(MAX_GRANTS, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => AccessGrantInputDto)
  grants!: AccessGrantInputDto[];
}

export class UpdateBranchAccessDto {
  @ApiProperty({
    type: [AccessGrantInputDto],
    description: "Replaces the private branch's grants as a whole (#474); `view` or `edit` only",
  })
  @IsArray()
  @ArrayMaxSize(MAX_GRANTS, { message: vmsg('arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => AccessGrantInputDto)
  grants!: AccessGrantInputDto[];
}

/** A note to a manager, not a document. */
const MAX_REQUEST_MESSAGE_CHARS = 1000;

export class CreateAccessRequestDto {
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiProperty({ enum: ACCESS_RESOURCE_TYPES })
  @IsIn(ACCESS_RESOURCE_TYPES)
  resourceType!: AccessResourceType;

  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  resourceId!: string;

  @ApiProperty({ enum: REQUESTABLE_ACCESS_LEVELS })
  @IsIn(REQUESTABLE_ACCESS_LEVELS)
  level!: RequestableAccessLevel;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Why — shown to the managers' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REQUEST_MESSAGE_CHARS, { message: vmsg('maxLength') })
  message?: string | null;
}

export class ListAccessRequestsQueryDto {
  // Field name must stay `workspaceId`: @Access('viewer','query') resolves it.
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiPropertyOptional({ enum: ACCESS_REQUEST_STATUSES, description: 'Omit for every status' })
  @IsOptional()
  @IsIn(ACCESS_REQUEST_STATUSES)
  status?: AccessRequestStatus;

  @ApiPropertyOptional({ description: "'1' for the caller's own requests; otherwise the ones they may decide" })
  @IsOptional()
  @IsIn(['1', 'true', '0', 'false'])
  mine?: string;

  @ApiPropertyOptional({ enum: ACCESS_RESOURCE_TYPES })
  @IsOptional()
  @IsIn(ACCESS_RESOURCE_TYPES)
  resourceType?: AccessResourceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(UUID_RE)
  resourceId?: string;
}

export class ApproveAccessRequestDto {
  @ApiPropertyOptional({ enum: ACCESS_LEVELS, description: 'Defaults to the level asked for' })
  @IsOptional()
  @IsIn(ACCESS_LEVELS)
  level?: AccessLevel;
}

export class DenyAccessRequestDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Shown to the requester' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REQUEST_MESSAGE_CHARS, { message: vmsg('maxLength') })
  reason?: string | null;
}
