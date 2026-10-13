import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  SITE_ASK_BUDGET_MAX,
  SITE_AUDIENCE_RULE_KINDS,
  SITE_EMBED_ORIGINS_MAX,
  SITE_FONTS,
  SITE_THEME_LIMITS,
  SITE_VERSION_KINDS,
  type SiteAudienceRuleKind,
  type SiteFont,
  type SiteVersionKind,
} from '@knowledge/contracts';
import { vmsg } from '../common/validation.js';

/**
 * Published sites (docs/features/44). The theme's contents are checked by
 * `siteThemeErrors` in the service, the one validator the reader's
 * `normalizeSiteTheme` mirrors; the decorators keep the envelope honest.
 */

export class SiteHeaderLinkDto {
  @ApiProperty({ maxLength: SITE_THEME_LIMITS.linkLabel })
  label!: string;

  @ApiProperty({ maxLength: SITE_THEME_LIMITS.linkUrl, description: 'Absolute http(s) URL' })
  url!: string;
}

export class SiteThemeDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: '`#rrggbb`; null keeps the app’s own primary' })
  primaryColor?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: '`#rrggbb` for dark mode; null reuses primaryColor' })
  primaryColorDark?: string | null;

  @ApiPropertyOptional({ enum: SITE_FONTS })
  font?: SiteFont;

  @ApiPropertyOptional({ description: 'Show the project’s avatar beside the site title' })
  showLogo?: boolean;

  @ApiPropertyOptional({ type: [SiteHeaderLinkDto], maxItems: SITE_THEME_LIMITS.headerLinks })
  headerLinks?: SiteHeaderLinkDto[];

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: SITE_THEME_LIMITS.footerText })
  footerText?: string | null;
}

export class CreateSiteDto {
  @ApiProperty({ description: '2–40 lowercase letters, digits and hyphens: `<slug>.PUBLISH_BASE_DOMAIN` or `/pub/<slug>`' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40, { message: vmsg('maxLength') })
  slug!: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'Publish only this page and its subpages. Omitted or null: the whole project' })
  @ValidateIf((o: CreateSiteDto) => o.rootDocumentId !== undefined && o.rootDocumentId !== null)
  @IsUUID()
  rootDocumentId?: string | null;
}

export class UpdateSiteDto {
  @ApiPropertyOptional({ description: 'A new address. The old one stops resolving at once' })
  @IsOptional()
  @IsString()
  @MaxLength(40, { message: vmsg('maxLength') })
  slug?: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'null publishes the whole project' })
  @ValidateIf((o: UpdateSiteDto) => o.rootDocumentId !== undefined && o.rootDocumentId !== null)
  @IsUUID()
  rootDocumentId?: string | null;

  @ApiPropertyOptional({ type: SiteThemeDto, description: 'Merged over the current theme; a key left out keeps its value' })
  @IsOptional()
  @IsObject()
  theme?: SiteThemeDto;

  @ApiPropertyOptional({ description: 'false: every page says noindex' })
  @IsOptional()
  @IsBoolean()
  seoIndexable?: boolean;

  @ApiPropertyOptional({ format: 'uuid', description: 'The version served without a version segment. Must have built once' })
  @IsOptional()
  @IsUUID()
  defaultVersionId?: string;

  @ApiPropertyOptional({ description: 'The site answers questions from its pages, in the reader and the embeddable widget' })
  @IsOptional()
  @IsBoolean()
  askEnabled?: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: SITE_ASK_BUDGET_MAX,
    description: 'Answers a day. null takes PUBLIC_ASK_DAILY_BUDGET, which also caps it',
  })
  @ValidateIf((o: UpdateSiteDto) => o.askDailyBudget !== undefined && o.askDailyBudget !== null)
  @IsInt()
  @Min(0)
  @Max(SITE_ASK_BUDGET_MAX)
  askDailyBudget?: number | null;

  @ApiPropertyOptional({
    type: [String],
    maxItems: SITE_EMBED_ORIGINS_MAX,
    description: 'Origins allowed to embed the widget, e.g. https://example.com. Replaces the list',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SITE_EMBED_ORIGINS_MAX)
  @IsString({ each: true })
  @MaxLength(300, { each: true, message: vmsg('maxLength') })
  embedOrigins?: string[];
}

export class CreateSiteVersionDto {
  @ApiProperty({ maxLength: 60, description: 'Shown in the version switcher, e.g. "v1.2"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60, { message: vmsg('maxLength') })
  name!: string;

  @ApiPropertyOptional({ maxLength: 32, description: 'URL segment. Omitted: derived from the name' })
  @IsOptional()
  @IsString()
  @MaxLength(32, { message: vmsg('maxLength') })
  slug?: string;

  @ApiProperty({ enum: SITE_VERSION_KINDS, description: '`live` rebuilds when its pages change; `frozen` only when rebuilt by hand' })
  @IsIn(SITE_VERSION_KINDS)
  kind!: SiteVersionKind;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 100,
    description: 'Branch name to read each page from; a page without it uses its default branch. Omitted or null: default branches',
  })
  @ValidateIf((o: CreateSiteVersionDto) => o.sourceBranch !== undefined && o.sourceBranch !== null)
  @IsString()
  @MaxLength(100, { message: vmsg('maxLength') })
  sourceBranch?: string | null;
}

export class UpdateSiteVersionDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60, { message: vmsg('maxLength') })
  name?: string;

  @ApiPropertyOptional({ enum: SITE_VERSION_KINDS })
  @IsOptional()
  @IsIn(SITE_VERSION_KINDS)
  kind?: SiteVersionKind;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100, description: 'A change rebuilds the version' })
  @ValidateIf((o: UpdateSiteVersionDto) => o.sourceBranch !== undefined && o.sourceBranch !== null)
  @IsString()
  @MaxLength(100, { message: vmsg('maxLength') })
  sourceBranch?: string | null;
}

export class AddSiteDomainDto {
  @ApiProperty({ maxLength: 253, description: 'A hostname you control, e.g. docs.example.com. A pasted URL is reduced to its host' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300, { message: vmsg('maxLength') })
  hostname!: string;
}

export class SetSiteAudienceRuleDto {
  @ApiProperty({ enum: SITE_AUDIENCE_RULE_KINDS, description: '`members`: signed-in workspace members only; `visitors`: also people signed in with a JWT from your backend' })
  @IsIn(SITE_AUDIENCE_RULE_KINDS)
  audience!: SiteAudienceRuleKind;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    nullable: true,
    description: '`visitors` only: claims the JWT must carry, each with one of the listed values, e.g. {"plan":["pro"]}. Omitted or null: any valid token',
  })
  @ValidateIf((o: SetSiteAudienceRuleDto) => o.claims !== undefined && o.claims !== null)
  @IsObject()
  claims?: Record<string, string[]> | null;
}

export class SiteSignInDto {
  @ApiProperty({ maxLength: 2000, description: 'The site page to come back to, as an absolute URL on one of the site’s own addresses' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000, { message: vmsg('maxLength') })
  returnUrl!: string;
}
