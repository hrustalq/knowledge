import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class InlineContentDto {
  @ApiProperty({ enum: ['inline'] })
  @IsIn(['inline'])
  mode!: 'inline';

  @ApiProperty({ example: 'markdown' })
  @IsString()
  @IsNotEmpty()
  format!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  text!: string;
}

export const RELATION_TYPES = [
  'DESCRIBES',
  'DEPENDS_ON',
  'IMPLEMENTS',
  'RELATED_TO',
  'OWNED_BY',
  'SUPERSEDES',
  'CONTRADICTS',
] as const;

export class RelationTargetDto {
  @ApiProperty({ example: 'service' })
  @IsString()
  @IsNotEmpty()
  type!: string;

  @ApiProperty({ example: 'service:identity' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiPropertyOptional({ example: 'Identity Service' })
  @IsOptional()
  @IsString()
  name?: string;
}

export class RelationInputDto {
  @ApiProperty({ enum: RELATION_TYPES })
  @IsIn(RELATION_TYPES as unknown as string[])
  type!: string;

  @ApiProperty({ type: RelationTargetDto })
  @IsObject()
  @ValidateNested()
  @Type(() => RelationTargetDto)
  target!: RelationTargetDto;
}

export class CreateDocumentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional({ type: InlineContentDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => InlineContentDto)
  content?: InlineContentDto;

  @ApiPropertyOptional({ type: [RelationInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RelationInputDto)
  relations?: RelationInputDto[];
}

export class CreateUploadDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  revisionId?: string;

  @ApiProperty({ example: 'text/markdown' })
  @IsString()
  @IsNotEmpty()
  contentType!: string;

  @ApiProperty({ example: 'source.md' })
  @IsString()
  @IsNotEmpty()
  filename!: string;
}

export class CreateRevisionDto {
  @ApiPropertyOptional({ default: 'main' })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({ example: 'text/markdown' })
  @IsOptional()
  @IsString()
  contentType?: string;
}

export class CreateBranchDto {
  @ApiProperty({ example: 'feature/oauth' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to the default-branch head' })
  @IsOptional()
  @IsUUID()
  fromRevisionId?: string;
}

export class CurateRelationDto {
  @ApiProperty({ type: () => RelationInputDto })
  @IsObject()
  @ValidateNested()
  @Type(() => RelationInputDto)
  relation!: RelationInputDto;
}

export class AddRelationsDto {
  @ApiProperty({ type: [RelationInputDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RelationInputDto)
  relations!: RelationInputDto[];
}
