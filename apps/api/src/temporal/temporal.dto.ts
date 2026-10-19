import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiQuery } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { RELEASE_TAG_NAME_PATTERN } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export const AS_OF_DESCRIPTION =
  'Read as of a point in time (#81): an ISO date, `rev:<revisionId>` (that revision’s finalize time) or `tag:<name>` (a release tag). ' +
  'A future date reads as now. Omitted: the current graph.';
export const KNOWN_AT_DESCRIPTION =
  'What was believed at this ISO date (system time): facts retracted later still show, facts written later do not. Omitted: now.';

/** `?asOf=&knownAt=` on a GET route. */
export function ApiAsOfQuery(): MethodDecorator {
  return applyDecorators(
    ApiQuery({ name: 'asOf', required: false, description: AS_OF_DESCRIPTION }),
    ApiQuery({ name: 'knownAt', required: false, description: KNOWN_AT_DESCRIPTION }),
  );
}

export class ListReleaseTagsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Workspace-wide tags plus this project’s; every tag when absent' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class CreateReleaseTagDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only this project’s views; the whole workspace when absent' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiProperty({ pattern: RELEASE_TAG_NAME_PATTERN, example: 'v2.3', description: 'Unique in the workspace' })
  @IsString()
  @Matches(new RegExp(RELEASE_TAG_NAME_PATTERN), { message: vmsg('matches') })
  name!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'The instant the tag names; now when absent' })
  @IsOptional()
  @IsISO8601()
  at?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: vmsg('maxLength') })
  note?: string;
}

export class GraphTimelineQueryDto extends ListReleaseTagsQueryDto {
  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Window start; 90 days before `to` when absent' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Window end; now when absent' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
