import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength, IsOptional } from 'class-validator';
import { ATTACHMENT_CONTENT_TYPES } from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class CreateAttachmentDto {
  @ApiProperty({ example: 'architecture.png', maxLength: 255 })
  @IsString()
  @MinLength(1, { message: vmsg('minLength') })
  @MaxLength(255, { message: vmsg('maxLength') })
  filename!: string;

  @ApiProperty({ enum: ATTACHMENT_CONTENT_TYPES, example: 'image/png' })
  @IsIn(ATTACHMENT_CONTENT_TYPES as readonly string[])
  contentType!: string;

  /** The file's exact size: the presigned PUT is signed for it, so another size is refused by the store. */
  @ApiProperty({ example: 148_231, minimum: 0 })
  @IsInt()
  @Min(0, { message: vmsg('min') })
  @Max(Number.MAX_SAFE_INTEGER, { message: vmsg('max') })
  sizeBytes!: number;
}
