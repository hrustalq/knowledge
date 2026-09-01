import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class GraphQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ example: 'SELECT documentId, targetKey, confidence FROM DEPENDS_ON' })
  @IsString()
  @IsNotEmpty()
  query!: string;

  @ApiPropertyOptional({ description: 'Row cap; clamped to GRAPH_QUERY_MAX_ROWS' })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
