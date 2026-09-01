import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateMergeRequestDto {
  @ApiProperty({ example: 'feature/oauth' })
  @IsString()
  @IsNotEmpty()
  sourceBranch!: string;

  @ApiPropertyOptional({ description: "Defaults to the document's default branch", example: 'main' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  targetBranch?: string;

  @ApiProperty({ example: 'Shorten access-token TTL' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class MergeMergeRequestDto {
  @ApiPropertyOptional({ enum: ['merge-commit', 'squash'], default: 'merge-commit' })
  @IsOptional()
  @IsIn(['merge-commit', 'squash'])
  strategy?: 'merge-commit' | 'squash';
}
