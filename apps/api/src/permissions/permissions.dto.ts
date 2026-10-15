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
import { ACCESS_LEVELS, ACCESS_SUBJECT_TYPES, type AccessLevel, type AccessSubjectType } from '@knowledge/contracts';
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
