import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  HEALTH_BULK_ACTIONS,
  HEALTH_BULK_MAX_IDS,
  HEALTH_FILTERS,
  TRUST_WEIGHT_KEYS,
  TRUST_WEIGHT_MAX,
  TRUST_WEIGHT_MIN,
  VERIFICATION_NOTE_MAX_CHARS,
  type TrustWeights,
  type HealthBulkAction,
  type HealthFilter,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

/** Ten years: long enough for "practically never" without meaning it. */
const MAX_INTERVAL_DAYS = 3650;

export class VerifyDocumentDto {
  /**
   * Also sets the page's review interval. Omitted keeps the current one;
   * `null` goes back to the workspace default; `0` means the stamp never
   * expires. Nullable, so the Swagger type is explicit (see CLAUDE.md gotchas).
   */
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Review interval in days. Omit to keep, null to inherit the workspace default, 0 for never',
  })
  @ValidateIf((o: VerifyDocumentDto) => o.intervalDays !== undefined && o.intervalDays !== null)
  @IsInt()
  @Min(0, { message: vmsg('min') })
  @Max(MAX_INTERVAL_DAYS, { message: vmsg('max') })
  intervalDays?: number | null;
}

export class FlagDocumentDto {
  @ApiPropertyOptional({ maxLength: VERIFICATION_NOTE_MAX_CHARS, description: 'Why — shown on the page and in the owner\'s notification' })
  @IsOptional()
  @IsString()
  @MaxLength(VERIFICATION_NOTE_MAX_CHARS, { message: vmsg('maxLength') })
  note?: string;
}

export class ArchiveDocumentDto {
  @ApiPropertyOptional({ description: 'Also the pages under this one. Omitted reads as true, so a parent is never archived over live children' })
  @IsOptional()
  @IsBoolean()
  includeDescendants?: boolean;
}

export class KnowledgeHealthQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ enum: HEALTH_FILTERS, description: 'Omitted lists every live page' })
  @IsOptional()
  @IsIn(HEALTH_FILTERS)
  filter?: HealthFilter;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only pages owned by this member' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({ maxLength: 200, description: 'Title substring, case-insensitive' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  q?: string;

  @ApiPropertyOptional({ enum: ['activity', 'title'], description: 'Omitted sorts by last activity, most neglected first' })
  @IsOptional()
  @IsIn(['activity', 'title'])
  sort?: 'activity' | 'title';

  @ApiPropertyOptional({ description: 'nextCursor of the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, description: 'Rows per page; omitted reads as 50' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(200, { message: vmsg('max') })
  limit?: number;
}

export class KnowledgeHealthSummaryQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class KnowledgeHealthBulkDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ type: [String], format: 'uuid', description: `At most ${HEALTH_BULK_MAX_IDS}; every id must belong to workspaceId or nothing is written` })
  @IsArray()
  @ArrayMinSize(1, { message: vmsg('arrayMinSize') })
  @ArrayMaxSize(HEALTH_BULK_MAX_IDS, { message: vmsg('arrayMaxSize') })
  @IsUUID('all', { each: true })
  documentIds!: string[];

  @ApiProperty({ enum: HEALTH_BULK_ACTIONS, description: 'archive / unarchive need admin' })
  @IsIn(HEALTH_BULK_ACTIONS)
  action!: HealthBulkAction;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'reassign: the new owner, null for unowned. Must be a workspace member' })
  @ValidateIf((o: KnowledgeHealthBulkDto) => o.ownerId !== undefined && o.ownerId !== null)
  @IsUUID()
  ownerId?: string | null;

  @ApiPropertyOptional({ maxLength: VERIFICATION_NOTE_MAX_CHARS, description: 'request / outdated: the note' })
  @IsOptional()
  @IsString()
  @MaxLength(VERIFICATION_NOTE_MAX_CHARS, { message: vmsg('maxLength') })
  note?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'verify: review interval in days (see VerifyDocumentDto)' })
  @ValidateIf((o: KnowledgeHealthBulkDto) => o.intervalDays !== undefined && o.intervalDays !== null)
  @IsInt()
  @Min(0, { message: vmsg('min') })
  @Max(MAX_INTERVAL_DAYS, { message: vmsg('max') })
  intervalDays?: number | null;
}

export class KnowledgeHealthSettingsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;
}

/**
 * A sparse map over TRUST_WEIGHTS (#305): a key left out keeps the code
 * default. One loop decorates every state, so a new state in the contract is
 * accepted here without a second list to forget.
 */
export class TrustWeightsDto implements Partial<Record<keyof TrustWeights, number>> {}
for (const key of TRUST_WEIGHT_KEYS) {
  for (const decorate of [
    ApiPropertyOptional({ type: Number, minimum: TRUST_WEIGHT_MIN, maximum: TRUST_WEIGHT_MAX }),
    IsOptional(),
    IsNumber({ allowNaN: false, allowInfinity: false }),
    Min(TRUST_WEIGHT_MIN, { message: vmsg('min') }),
    Max(TRUST_WEIGHT_MAX, { message: vmsg('max') }),
  ]) {
    decorate(TrustWeightsDto.prototype, key);
  }
}

/** Every field nullable: `null` resets that key to "inherit the env default". */
export class UpdateKnowledgeHealthSettingsDto {
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Days a stamp holds; 0 = never' })
  @ValidateIf((o: UpdateKnowledgeHealthSettingsDto) => o.reviewIntervalDays !== undefined && o.reviewIntervalDays !== null)
  @IsInt()
  @Min(0, { message: vmsg('min') })
  @Max(MAX_INTERVAL_DAYS, { message: vmsg('max') })
  reviewIntervalDays?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @ValidateIf((o: UpdateKnowledgeHealthSettingsDto) => o.remindBeforeDays !== undefined && o.remindBeforeDays !== null)
  @IsInt()
  @Min(0, { message: vmsg('min') })
  @Max(MAX_INTERVAL_DAYS, { message: vmsg('max') })
  remindBeforeDays?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '0 disables inactivity' })
  @ValidateIf((o: UpdateKnowledgeHealthSettingsDto) => o.inactiveAfterDays !== undefined && o.inactiveAfterDays !== null)
  @IsInt()
  @Min(0, { message: vmsg('min') })
  @Max(MAX_INTERVAL_DAYS, { message: vmsg('max') })
  inactiveAfterDays?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @ValidateIf((o: UpdateKnowledgeHealthSettingsDto) => o.emptyMaxChars !== undefined && o.emptyMaxChars !== null)
  @IsInt()
  @Min(0, { message: vmsg('min') })
  @Max(100_000, { message: vmsg('max') })
  emptyMaxChars?: number | null;

  @ApiPropertyOptional({ type: Boolean, nullable: true, description: 'Multiply search scores by the page\'s verification state' })
  @ValidateIf((o: UpdateKnowledgeHealthSettingsDto) => o.trustRanking !== undefined && o.trustRanking !== null)
  @IsBoolean()
  trustRanking?: boolean | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Reciprocal-rank-fusion constant; null = 60' })
  @ValidateIf((o: UpdateKnowledgeHealthSettingsDto) => o.rrfK !== undefined && o.rrfK !== null)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(1000, { message: vmsg('max') })
  rrfK?: number | null;

  @ApiPropertyOptional({
    type: TrustWeightsDto,
    nullable: true,
    description: 'Per-state search weights; a state left out keeps its default, null resets them all',
  })
  @ValidateIf((o: UpdateKnowledgeHealthSettingsDto) => o.trustWeights !== undefined && o.trustWeights !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => TrustWeightsDto)
  trustWeights?: TrustWeightsDto | null;
}
