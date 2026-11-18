import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { ADMIN_ERROR_PERIODS, OPS_PROCESS_KINDS, type OpsProcessKind } from '@knowledge/contracts';

/** `?process=api,worker` → `['api', 'worker']`; repeated params arrive as an array already. */
const toList = ({ value }: { value: unknown }) =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map((s) => String(s).trim()).filter(Boolean);

export class AdminErrorsQueryDto {
  @ApiPropertyOptional({ enum: ADMIN_ERROR_PERIODS, type: Number, description: 'Hours back from now. Omitted: 24' })
  @IsOptional()
  @Type(() => Number)
  @IsIn(ADMIN_ERROR_PERIODS)
  hours?: number;

  @ApiPropertyOptional({ type: String, description: `Comma-separated processes (${OPS_PROCESS_KINDS.join(', ')})` })
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn(OPS_PROCESS_KINDS, { each: true })
  process?: OpsProcessKind[];

  @ApiPropertyOptional({ type: String, description: 'Comma-separated workspace ids' })
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  workspaceId?: string[];

  @ApiPropertyOptional({ description: 'Text the message contains, or a trace id' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  q?: string;

  @ApiPropertyOptional({ description: "The previous page's nextCursor" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z~[0-9a-f]{32}$/)
  cursor?: string;
}
