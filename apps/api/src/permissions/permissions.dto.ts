import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
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
