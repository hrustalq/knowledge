import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength, IsOptional } from 'class-validator';
import { ATTACHMENT_CONTENT_TYPES } from '@knowledge/contracts';

export class CreateAttachmentDto {
  @ApiProperty({ example: 'architecture.png', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ enum: ATTACHMENT_CONTENT_TYPES, example: 'image/png' })
  @IsIn(ATTACHMENT_CONTENT_TYPES as readonly string[])
  contentType!: string;

  /** Advisory: lets the API reject an oversized upload before the bytes move. */
  @ApiPropertyOptional({ example: 148_231, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes?: number;
}
