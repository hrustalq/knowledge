import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  AUTHORABLE_RELATION_TYPES,
  CAPTURE_CLIENTS,
  CAPTURE_ITEM_MAX_CHARS,
  CAPTURE_KINDS,
  CAPTURE_LIST_MAX,
  CAPTURE_NOTE_KINDS,
  CAPTURE_SESSION_MAX_FILES,
  CAPTURE_STATUSES,
  CAPTURE_TITLE_MAX_CHARS,
  type CaptureClient,
  type CaptureKind,
  type CaptureStatus,
  type CreateCaptureRequest,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

/** Mirrors UUID_RE in acl.guard.ts (any version digit, nil allowed). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The long text fields, the same ceilings the MCP tools declare; CAPTURE_MAX_CHARS caps the whole capture after. */
const LONG_TEXT_MAX = 20_000;

const NOTE_KINDS: readonly string[] = CAPTURE_NOTE_KINDS;
const is = (...kinds: CaptureKind[]) => (o: CreateCaptureDto) => kinds.includes(o.kind);

export class CaptureSessionDto {
  @ApiProperty({ enum: CAPTURE_CLIENTS })
  @IsIn(CAPTURE_CLIENTS)
  client!: CaptureClient;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100, { message: vmsg('maxLength') })
  clientVersion?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200, { message: vmsg('maxLength') })
  sessionId?: string;

  @ApiPropertyOptional({ description: 'owner/name or the remote URL' })
  @IsOptional() @IsString() @MaxLength(300, { message: vmsg('maxLength') })
  repo?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300, { message: vmsg('maxLength') })
  branch?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100, { message: vmsg('maxLength') })
  commit?: string;

  @ApiPropertyOptional({ type: [String], description: 'Repository paths the session touched — paths only' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CAPTURE_SESSION_MAX_FILES)
  @IsString({ each: true })
  @MaxLength(500, { each: true, message: vmsg('maxLength') })
  files?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40, { message: vmsg('maxLength') })
  startedAt?: string;
}

/**
 * `POST /v1/captures`: the MCP capture tools' input as one flat body,
 * discriminated by `kind`. Each kind's required fields are required only for
 * that kind (`ValidateIf`), and `toCaptureRequest` hands the service exactly
 * the contracts union — fields of another kind never reach it.
 */
export class CreateCaptureDto {
  // Field name must stay `workspaceId`: @Access('editor','body') resolves it.
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiProperty({ enum: CAPTURE_KINDS })
  @IsIn(CAPTURE_KINDS)
  kind!: CaptureKind;

  @ApiProperty({ type: CaptureSessionDto })
  @ValidateNested()
  @Type(() => CaptureSessionDto)
  session!: CaptureSessionDto;

  @ApiPropertyOptional({
    description: "Required except for a relation (the page's project) and an answer (defaults to the first cited page's)",
  })
  @ValidateIf((o: CreateCaptureDto) => !['relation', 'answer'].includes(o.kind) || o.projectId !== undefined)
  @IsString()
  @Matches(UUID_RE)
  projectId?: string;

  @ApiPropertyOptional({ description: 'Required for a decision and a note; an answer defaults to its question' })
  @ValidateIf((o: CreateCaptureDto) => o.kind === 'decision' || NOTE_KINDS.includes(o.kind) || o.title !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CAPTURE_TITLE_MAX_CHARS, { message: vmsg('maxLength') })
  title?: string;

  // decision
  @ApiPropertyOptional({ description: 'decision: the problem and the forces at play' })
  @ValidateIf(is('decision'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(LONG_TEXT_MAX, { message: vmsg('maxLength') })
  context?: string;

  @ApiPropertyOptional({ description: 'decision: what was decided and why' })
  @ValidateIf(is('decision'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(LONG_TEXT_MAX, { message: vmsg('maxLength') })
  decision?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(LONG_TEXT_MAX, { message: vmsg('maxLength') })
  consequences?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CAPTURE_LIST_MAX)
  @IsString({ each: true })
  @MaxLength(CAPTURE_ITEM_MAX_CHARS, { each: true, message: vmsg('maxLength') })
  alternatives?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CAPTURE_LIST_MAX)
  @Matches(UUID_RE, { each: true })
  relatedDocumentIds?: string[];

  // gotcha | convention | howto
  @ApiPropertyOptional({ description: 'gotcha/convention/howto: markdown' })
  @ValidateIf((o: CreateCaptureDto) => NOTE_KINDS.includes(o.kind))
  @IsString()
  @IsNotEmpty()
  @MaxLength(LONG_TEXT_MAX, { message: vmsg('maxLength') })
  body?: string;

  @ApiPropertyOptional({ type: [String], description: 'Repository paths or entity keys the note is about' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CAPTURE_LIST_MAX)
  @IsString({ each: true })
  @MaxLength(CAPTURE_ITEM_MAX_CHARS, { each: true, message: vmsg('maxLength') })
  appliesTo?: string[];

  // glossary
  @ApiPropertyOptional()
  @ValidateIf(is('glossary'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200, { message: vmsg('maxLength') })
  term?: string;

  @ApiPropertyOptional()
  @ValidateIf(is('glossary'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000, { message: vmsg('maxLength') })
  definition?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CAPTURE_LIST_MAX)
  @IsString({ each: true })
  @MaxLength(CAPTURE_ITEM_MAX_CHARS, { each: true, message: vmsg('maxLength') })
  aliases?: string[];

  /** relation: the page the relation is added to; glossary: a page defining the term in full. */
  @ApiPropertyOptional({ description: 'relation: the page to add it to (required); glossary: a page that defines the term' })
  @ValidateIf((o: CreateCaptureDto) => o.kind === 'relation' || o.documentId !== undefined)
  @IsString()
  @Matches(UUID_RE)
  documentId?: string;

  // relation
  @ApiPropertyOptional({ enum: AUTHORABLE_RELATION_TYPES })
  @ValidateIf(is('relation'))
  @IsIn(AUTHORABLE_RELATION_TYPES)
  type?: string;

  @ApiPropertyOptional({ description: 'relation: entity key, e.g. "service:billing"' })
  @ValidateIf(is('relation'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(300, { message: vmsg('maxLength') })
  targetKey?: string;

  @ApiPropertyOptional()
  @ValidateIf(is('relation'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000, { message: vmsg('maxLength') })
  rationale?: string;

  // answer
  @ApiPropertyOptional()
  @ValidateIf(is('answer'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000, { message: vmsg('maxLength') })
  question?: string;

  @ApiPropertyOptional()
  @ValidateIf(is('answer'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(LONG_TEXT_MAX, { message: vmsg('maxLength') })
  answer?: string;

  @ApiPropertyOptional({ type: [String], description: 'answer: at least one' })
  @ValidateIf(is('answer'))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CAPTURE_LIST_MAX)
  @Matches(UUID_RE, { each: true })
  citedDocumentIds?: string[];
}

/** The validated body as the contracts union, one kind's fields only. */
export function toCaptureRequest(dto: CreateCaptureDto): CreateCaptureRequest {
  const base = { workspaceId: dto.workspaceId, session: { ...dto.session } };
  const opt = <K extends string, V>(key: K, value: V | undefined) =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
  switch (dto.kind) {
    case 'decision':
      return {
        ...base,
        kind: 'decision',
        projectId: dto.projectId!,
        title: dto.title!,
        context: dto.context!,
        decision: dto.decision!,
        ...opt('consequences', dto.consequences),
        ...opt('alternatives', dto.alternatives),
        ...opt('relatedDocumentIds', dto.relatedDocumentIds),
      };
    case 'gotcha':
    case 'convention':
    case 'howto':
      return { ...base, kind: dto.kind, projectId: dto.projectId!, title: dto.title!, body: dto.body!, ...opt('appliesTo', dto.appliesTo) };
    case 'glossary':
      return {
        ...base,
        kind: 'glossary',
        projectId: dto.projectId!,
        term: dto.term!,
        definition: dto.definition!,
        ...opt('aliases', dto.aliases),
        ...opt('documentId', dto.documentId),
      };
    case 'relation':
      return { ...base, kind: 'relation', documentId: dto.documentId!, type: dto.type!, targetKey: dto.targetKey!, rationale: dto.rationale! };
    case 'answer':
      return {
        ...base,
        kind: 'answer',
        ...opt('projectId', dto.projectId),
        ...opt('title', dto.title),
        question: dto.question!,
        answer: dto.answer!,
        citedDocumentIds: dto.citedDocumentIds!,
      };
  }
}

export class ListCapturesQueryDto {
  // Field name must stay `workspaceId`: @Access('viewer','query') resolves it.
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiPropertyOptional({ enum: CAPTURE_STATUSES, description: 'Stored status; merged/closed read from the merge request' })
  @IsOptional()
  @IsIn(CAPTURE_STATUSES)
  status?: CaptureStatus;

  @ApiPropertyOptional({ enum: CAPTURE_KINDS })
  @IsOptional()
  @IsIn(CAPTURE_KINDS)
  kind?: CaptureKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(UUID_RE)
  projectId?: string;

  @ApiPropertyOptional({ description: "'1' or 'true': only the caller's own captures" })
  @IsOptional()
  @IsIn(['1', 'true', '0', 'false'])
  mine?: string;

  @ApiPropertyOptional({ description: "Only this key's captures. Another person's key takes an editor (403 otherwise)" })
  @IsOptional()
  @IsString()
  @Matches(UUID_RE)
  apiKeyId?: string;

  @ApiPropertyOptional({ description: 'The last capture id of the previous page' })
  @IsOptional()
  @IsString()
  @Matches(UUID_RE)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, description: 'Defaults to 50' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: vmsg('min') })
  @Max(100, { message: vmsg('max') })
  limit?: number;
}

export class RejectCaptureDto {
  @ApiPropertyOptional({ description: 'Why, for the activity log' })
  @IsOptional()
  @IsString()
  @MaxLength(1_000, { message: vmsg('maxLength') })
  reason?: string;
}

export class BulkRejectCapturesDto {
  // Field name must stay `workspaceId`: @Access('editor','body') resolves it.
  @ApiProperty()
  @IsString()
  @Matches(UUID_RE)
  workspaceId!: string;

  @ApiProperty({ description: 'The key whose pending captures are turned down' })
  @IsString()
  @Matches(UUID_RE)
  apiKeyId!: string;

  @ApiPropertyOptional({ description: 'Why, for the activity log of each capture' })
  @IsOptional()
  @IsString()
  @MaxLength(1_000, { message: vmsg('maxLength') })
  reason?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Count what would be rejected and closed, and change nothing. Defaults to false' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class CaptureAssistantMessageDto {
  @ApiPropertyOptional({ description: "Defaults to the first cited page's project" })
  @IsOptional()
  @IsString()
  @Matches(UUID_RE)
  projectId?: string;

  @ApiPropertyOptional({ description: 'Defaults to the question' })
  @IsOptional()
  @IsString()
  @MaxLength(CAPTURE_TITLE_MAX_CHARS, { message: vmsg('maxLength') })
  title?: string;
}
