import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class AssistantReviewDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300)
  title!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  markdown!: string;
}

export class AssistantSuggestDto extends AssistantReviewDto {
  @ApiProperty({ example: 'Draft an outline for the missing sections' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  instruction!: string;
}

export class AssistantRelatedDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ description: 'Draft text (an excerpt is used as the search query)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50_000)
  text!: string;

  @ApiPropertyOptional({ default: 5, minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

export class AssistantAskTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000)
  content!: string;
}

export class AssistantAskDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  documentId!: string;

  @ApiProperty({ example: 'Why do sessions get revoked on password reset?' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000)
  question!: string;

  @ApiPropertyOptional({ type: [AssistantAskTurnDto], description: 'Prior turns, most recent last' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AssistantAskTurnDto)
  history?: AssistantAskTurnDto[];
}
