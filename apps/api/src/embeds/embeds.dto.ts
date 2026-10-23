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
