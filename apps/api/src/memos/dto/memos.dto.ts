import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { vmsg } from '../../common/validation.js';

export class RenameMemoDto {
  @ApiProperty({ description: 'Shown in the list and on the memo; a Plaud memo keeps Plaud\'s own name as its filename' })
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(300, { message: vmsg('maxLength') })
  title!: string;
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
