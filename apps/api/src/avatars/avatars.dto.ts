import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import { AVATAR_CONTENT_TYPES, AVATAR_MAX_BYTES } from '@knowledge/contracts';

export class CreateAvatarUploadDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @Length(1, 200)
  filename!: string;

  @ApiProperty({ enum: AVATAR_CONTENT_TYPES })
  @IsIn(AVATAR_CONTENT_TYPES as readonly string[])
  contentType!: (typeof AVATAR_CONTENT_TYPES)[number];

  @ApiProperty({
    description: `Byte length of the file. Refused above ${AVATAR_MAX_BYTES}, and re-checked against what actually arrives on complete.`,
  })
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

export class CompleteAvatarUploadDto {
  @ApiProperty({ description: 'The uploadId returned by the reserve step.' })
  @IsString()
  @Length(1, 64)
  uploadId!: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @Length(1, 200)
  filename!: string;
}
