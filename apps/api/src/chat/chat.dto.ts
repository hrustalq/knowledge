import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import {
  CHAT_ANSWER_MODES,
  CHAT_PLATFORM_KINDS,
  SUPPORTED_LOCALES,
  type ChatAnswerMode,
  type ChatPlatformKind,
  type Locale,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

export class CreateChatIntegrationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ enum: CHAT_PLATFORM_KINDS })
  @IsIn([...CHAT_PLATFORM_KINDS])
  kind!: ChatPlatformKind;

  @ApiProperty({ maxLength: 80, example: 'Team bot' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80, { message: vmsg('maxLength') })
  name!: string;

  @ApiProperty({ description: 'The bot token (Telegram: from @BotFather). Write-only — never returned.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512, { message: vmsg('maxLength') })
  token!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Agent that answers; omitted or null means the researcher' })
  @ValidateIf((o: CreateChatIntegrationDto) => o.defaultAgentKey !== undefined && o.defaultAgentKey !== null)
  @IsString()
  @MaxLength(64, { message: vmsg('maxLength') })
  defaultAgentKey?: string | null;

  @ApiPropertyOptional({ enum: SUPPORTED_LOCALES, description: 'Reply language when the asker has none. Omitted reads as en' })
  @IsOptional()
  @IsIn([...SUPPORTED_LOCALES])
  locale?: Locale;
}

export class UpdateChatIntegrationDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Replaces the stored token; omit to keep it' })
  @IsOptional()
  @IsString()
  @MaxLength(512, { message: vmsg('maxLength') })
  token?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Omit to keep; null goes back to the researcher' })
  @ValidateIf((o: UpdateChatIntegrationDto) => o.defaultAgentKey !== undefined && o.defaultAgentKey !== null)
  @IsString()
  @MaxLength(64, { message: vmsg('maxLength') })
  defaultAgentKey?: string | null;

  @ApiPropertyOptional({ enum: SUPPORTED_LOCALES })
  @IsOptional()
  @IsIn([...SUPPORTED_LOCALES])
  locale?: Locale;
}

export class CreateChatBindingDto {
  @ApiProperty({ description: "The platform's chat id (Telegram: -100…). /bind in the group sets it without typing it." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64, { message: vmsg('maxLength') })
  externalChatId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @ValidateIf((o: CreateChatBindingDto) => o.title !== undefined && o.title !== null)
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  title?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'Answer from this project only; null = whole workspace' })
  @ValidateIf((o: CreateChatBindingDto) => o.projectId !== undefined && o.projectId !== null)
  @IsUUID()
  projectId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: "null = the bot's default agent" })
  @ValidateIf((o: CreateChatBindingDto) => o.agentKey !== undefined && o.agentKey !== null)
  @IsString()
  @MaxLength(64, { message: vmsg('maxLength') })
  agentKey?: string | null;

  @ApiPropertyOptional({ enum: CHAT_ANSWER_MODES, description: 'Omitted reads as mention' })
  @IsOptional()
  @IsIn([...CHAT_ANSWER_MODES])
  answerMode?: ChatAnswerMode;

  @ApiPropertyOptional({ type: String, nullable: true, enum: SUPPORTED_LOCALES, description: "null = the bot's language" })
  @ValidateIf((o: CreateChatBindingDto) => o.locale !== undefined && o.locale !== null)
  @IsIn([...SUPPORTED_LOCALES])
  locale?: Locale | null;
}

export class UpdateChatBindingDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @ValidateIf((o: UpdateChatBindingDto) => o.title !== undefined && o.title !== null)
  @IsString()
  @MaxLength(200, { message: vmsg('maxLength') })
  title?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @ValidateIf((o: UpdateChatBindingDto) => o.projectId !== undefined && o.projectId !== null)
  @IsUUID()
  projectId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((o: UpdateChatBindingDto) => o.agentKey !== undefined && o.agentKey !== null)
  @IsString()
  @MaxLength(64, { message: vmsg('maxLength') })
  agentKey?: string | null;

  @ApiPropertyOptional({ enum: CHAT_ANSWER_MODES })
  @IsOptional()
  @IsIn([...CHAT_ANSWER_MODES])
  answerMode?: ChatAnswerMode;

  @ApiPropertyOptional({ type: String, nullable: true, enum: SUPPORTED_LOCALES })
  @ValidateIf((o: UpdateChatBindingDto) => o.locale !== undefined && o.locale !== null)
  @IsIn([...SUPPORTED_LOCALES])
  locale?: Locale | null;
}

export class ChatLinkCodeDto {
  @ApiProperty({ description: 'The code from the link the bot sent' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128, { message: vmsg('maxLength') })
  code!: string;
}
