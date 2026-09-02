import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

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
