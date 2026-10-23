import { IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EMBED_ITEM_STATES, type EmbedItemState } from '@knowledge/contracts';

export class EmbedItemStatusDto {
  @ApiProperty() fileKey!: string;
  @ApiProperty({ description: "'' for a whole-file item" }) nodeId!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ enum: EMBED_ITEM_STATES }) state!: EmbedItemState;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
}

export class DocumentEmbedsResponseDto {
  @ApiProperty({ type: [EmbedItemStatusDto] }) items!: EmbedItemStatusDto[];
}

export class FigmaWorkspaceQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

export class FigmaResolveDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ description: 'A Figma design, prototype, Dev Mode or FigJam link' })
  @IsString()
  @MaxLength(2000)
  url!: string;
}

export class FigmaPickerFileEntryDto {
  @ApiProperty() fileKey!: string;
  @ApiProperty() name!: string;
}

export class FigmaPickerFilesResponseDto {
  @ApiProperty() connected!: boolean;
  @ApiProperty({ type: [FigmaPickerFileEntryDto] }) files!: FigmaPickerFileEntryDto[];
}

export class FigmaPickerFrameDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ type: String, nullable: true }) thumbnailUrl!: string | null;
}

export class FigmaPickerPageDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [FigmaPickerFrameDto] }) frames!: FigmaPickerFrameDto[];
}

export class FigmaPickerFileResponseDto {
  @ApiProperty() fileKey!: string;
  @ApiProperty() name!: string;
  @ApiProperty() version!: string;
  @ApiProperty() board!: boolean;
  @ApiProperty({ type: [FigmaPickerPageDto] }) pages!: FigmaPickerPageDto[];
}

export class FigmaResolveResponseDto {
  @ApiProperty() url!: string;
  @ApiProperty({ type: String, nullable: true }) version!: string | null;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty() allowed!: boolean;
}
