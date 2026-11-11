import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';
import { MEMO_TYPE_KEY_RE } from '@knowledge/contracts';
import { vmsg } from '../../common/validation.js';

export class RenameMemoDto {
  @ApiPropertyOptional({ description: 'Shown in the list and on the memo; a Plaud memo keeps Plaud\'s own name as its filename' })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(300, { message: vmsg('maxLength') })
  title?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'A memo type\'s key from GET /v1/memos/types, or null for none' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(MEMO_TYPE_KEY_RE)
  type?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Topic tags: trimmed, lower-cased, at most five kept' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags?: string[];
}

export class ConfirmMemoDto {
  @ApiProperty({ type: String, nullable: true, description: 'A memo type\'s key, or null for none' })
  @ValidateIf((_, value) => value !== null)
  @Matches(MEMO_TYPE_KEY_RE)
  type!: string | null;

  @ApiProperty({ format: 'uuid', description: 'The project the memo is filed into and analysed against' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags!: string[];
}

export class MemoTypesQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

export class SaveMemoTypeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Null or empty = the built-in name; required for a type of your own' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(80, { message: vmsg('maxLength') })
  name?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'How the agent treats a recording of this kind. Null or empty = the built-in guidance' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(4000, { message: vmsg('maxLength') })
  guidance?: string | null;

  @ApiPropertyOptional({ description: 'Hidden types are not offered; memos already of the type keep it' })
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Where a memo detected as this type goes; null = the project it arrived in' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  projectId?: string | null;

  @ApiPropertyOptional({ description: 'A memo detected as this type is analysed without waiting for its owner\'s confirm' })
  @IsOptional()
  @IsBoolean()
  auto?: boolean;
}

export class MatchMemoSpeakerDto {
  @ApiProperty({ description: 'A speaker label exactly as the transcript has it' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300, { message: vmsg('maxLength') })
  label!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'A member of the workspace, or null for nobody here' })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  userId!: string | null;
}

export class CreateMemoDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid', description: 'The project the memo belongs to; its proposals are filed there' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ description: 'Original filename — its extension decides the format' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255, { message: vmsg('maxLength') })
  filename!: string;

  @ApiProperty()
  @IsString()
  contentType!: string;

  @ApiProperty({ description: 'Claimed size; re-checked against the bucket at finalize' })
  @IsInt()
  @IsPositive()
  sizeBytes!: number;

  @ApiPropertyOptional({ description: 'Shown in the list; defaults to the filename without its extension' })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: vmsg('maxLength') })
  title?: string;

  @ApiPropertyOptional({ description: 'Length the browser read from the file, refused early when over the ceiling' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  durationSeconds?: number;
}

export class ListMemosQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Only memos of this type' })
  @IsOptional()
  @Matches(MEMO_TYPE_KEY_RE)
  type?: string;
}

export class ImportPlaudMemoDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid', description: 'The project the memo belongs to; its proposals are filed there' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ description: 'The recording\'s id in the caller\'s Plaud account' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: vmsg('maxLength') })
  fileId!: string;
}
