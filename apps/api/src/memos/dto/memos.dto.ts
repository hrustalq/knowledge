import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';
import { vmsg } from '../../common/validation.js';

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
