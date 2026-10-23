import type { Locale } from '@knowledge/contracts/core';
import type { DocumentCategory } from '@knowledge/contracts/documents';
import { FRONTMATTER_KEY_ALIASES, normalizeEntityKey } from '@knowledge/contracts/graph';

// ---------------------------------------------------------------------------
// Page templates (issue #69).
//
// A template is markdown with one reserved frontmatter key, `template:`, that
// carries its metadata (category, title pattern, declared placeholders, AI
// instructions). `tags:` and `relations:` pass through to the page unchanged,
// so a page created from a template is linked into the graph from its first
// revision.
//
// Templates are NOT documents: they are never indexed, never searched and never
// branched. They live in their own tables with a linear, immutable version list
// so "which shape produced this page" stays answerable after the template moves
// on (`documents.template_ref` + `template_version`).
//
// The render functions below are pure string substitution — no YAML, no I/O —
// and are imported by the API (render, document creation), the worker
// (workflows) and the web (the gallery's live preview). One implementation is
// what stops the preview and the created page from disagreeing.

/**
 * Templates shipped in code. Never seeded as rows (the `built-in-agents.ts`
 * argument): a release can improve the ADR template for every workspace that
 * never touched it, and "reset to default" has a meaning.
 */
export const BUILT_IN_TEMPLATE_KEYS = [
  'adr',
  'rfc',
  'runbook',
  'postmortem',
  'api-spec',
  'use-case',
  'entity',
  'component',
  'test-plan',
  'test-case',
  'test-data',
  'bug-report',
] as const;
export type BuiltInTemplateKey = (typeof BUILT_IN_TEMPLATE_KEYS)[number];

export function isBuiltInTemplateKey(value: string): value is BuiltInTemplateKey {
  return (BUILT_IN_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/**
 * How a declared placeholder's value is rendered.
 *
 * - `text`   — substituted as written.
 * - `date`   — an ISO `YYYY-MM-DD`, formatted in the caller's locale.
 * - `user`   — a user id, rendered as a mention chip by code (never a raw link).
 * - `page`   — a document id, rendered as a page mention chip.
 * - `entity` — an entity key; folded through `normalizeEntityKey` wherever it
 *              lands in frontmatter, so a template cannot fork a vertex.
 */
export const TEMPLATE_PLACEHOLDER_KINDS = ['text', 'date', 'user', 'page', 'entity'] as const;
export type TemplatePlaceholderKind = (typeof TEMPLATE_PLACEHOLDER_KINDS)[number];

/** Always available, never declared: filled in by whoever renders. */
export const SYSTEM_PLACEHOLDERS = ['title', 'date', 'author', 'project', 'parent'] as const;
export type SystemPlaceholder = (typeof SYSTEM_PLACEHOLDERS)[number];

/** What a placeholder name may look like — also what the substitution regex matches. */
export const TEMPLATE_PLACEHOLDER_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface TemplatePlaceholder {
  name: string;
  /** Form label; falls back to the name. */
  label?: string;
  kind: TemplatePlaceholderKind;
  required?: boolean;
  /** Example or help text shown under the field. */
  hint?: string;
}

/** The parsed `template:` frontmatter block. */
export interface TemplateMeta {
  /** Default category of a page created from this template. */
  category: DocumentCategory;
  /** Title of the created page, e.g. `ADR-{{number}}: {{title}}`. Absent = the title as typed. */
  titlePattern?: string;
  description?: string;
  placeholders: TemplatePlaceholder[];
  /**
   * Guidance for an assistant filling the skeleton. Workspace-authored text,
   * so always handed to a model wrapped as untrusted, never as system text.
   */
  aiInstructions?: string;
}

// --- references ---------------------------------------------------------------

/** A template uuid, or `builtin:<key>` for a template shipped in code. */
export type TemplateRef = string;

export const BUILT_IN_TEMPLATE_REF_PREFIX = 'builtin:';

export function builtInTemplateRef(key: BuiltInTemplateKey): TemplateRef {
  return `${BUILT_IN_TEMPLATE_REF_PREFIX}${key}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedTemplateRef =
  | { kind: 'builtin'; key: BuiltInTemplateKey }
  | { kind: 'custom'; id: string };

/** A ref, or null when it is neither a uuid nor a known built-in. */
export function parseTemplateRef(ref: string): ParsedTemplateRef | null {
  const trimmed = ref.trim();
  if (trimmed.startsWith(BUILT_IN_TEMPLATE_REF_PREFIX)) {
    const key = trimmed.slice(BUILT_IN_TEMPLATE_REF_PREFIX.length);
    return isBuiltInTemplateKey(key) ? { kind: 'builtin', key } : null;
  }
  return UUID_RE.test(trimmed) ? { kind: 'custom', id: trimmed.toLowerCase() } : null;
}

// --- API shapes -----------------------------------------------------------------

/**
 * Where a template is offered. `built-in` covers both an untouched code
 * template and a workspace's customisation of one — the ref stays
 * `builtin:<key>` either way, so a workflow naming it picks up the override.
 */
export type TemplateScope = 'built-in' | 'workspace' | 'project';

export interface TemplateSummary {
  ref: TemplateRef;
  /** The row id, when one exists (a custom template, or a built-in override). */
  id: string | null;
  builtInKey: BuiltInTemplateKey | null;
  scope: TemplateScope;
  workspaceId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  /** An emoji. */
  icon: string | null;
  category: DocumentCategory;
  currentVersion: number;
  /** False on a built-in a workspace has hidden. */
  enabled: boolean;
  /** True when a built-in carries the workspace's own versions. */
  customized: boolean;
  archivedAt: string | null;
  updatedAt: string | null;
}

/** One relation as a template declares it, before placeholders are filled in. */
export interface TemplateRelationDefault {
  type: string;
  target: string;
}

export interface TemplateDetail extends TemplateSummary {
  /** Full markdown including the frontmatter and its `template:` block. */
  source: string;
  meta: TemplateMeta;
  /** The body, frontmatter removed. */
  body: string;
  /** Default `tags:` and `relations:`, placeholders still unfilled. */
  tags: string[];
  relations: TemplateRelationDefault[];
  /**
   * Every frontmatter key the page inherits, `template:` removed — `tags` and
   * `relations` included, as written. An editor that models only some keys
   * re-emits the rest from here (`composeTemplateSource`), rather than
   * destroying them on save.
   */
  frontmatter: Record<string, unknown>;
  /** The version this detail describes (= `currentVersion` unless a version was asked for). */
  version: number;
}

// GET /v1/templates
export interface ListTemplatesResponse {
  templates: TemplateSummary[];
}

export interface TemplateVersionInfo {
  version: number;
  createdBy: string | null;
  createdAt: string | null;
  /** True for the version shipped in code (an un-customised built-in's only version). */
  builtIn: boolean;
}

// GET /v1/templates/:id/versions
export interface ListTemplateVersionsResponse {
  versions: TemplateVersionInfo[];
}

/** Placeholder values: plain text, an ISO date, or a user/page id, by kind. */
export type TemplateValues = Record<string, string>;

// POST /v1/templates/render
export interface RenderTemplateRequest {
  workspaceId: string;
  ref: TemplateRef;
  version?: number;
  /** The page title as typed — the `{{title}}` system placeholder. */
  title?: string;
  values?: TemplateValues;
  projectId?: string;
  parentId?: string;
}

export interface RenderTemplateResponse {
  templateRef: TemplateRef;
  templateVersion: number;
  /** The title pattern, rendered. */
  title: string;
  category: DocumentCategory;
  /** The page's frontmatter: `template:` stripped, placeholders filled in. */
  frontmatter: Record<string, unknown>;
  body: string;
  /** `frontmatter` + `body` as one markdown source, ready to publish. */
  markdown: string;
}

// --- rendering ------------------------------------------------------------------

/** Everything a render needs that is not a declared value. */
export interface TemplateRenderContext {
  locale: Locale;
  /** `{{title}}`. */
  title: string;
  /** "Now" for `{{date}}`; an ISO string or a Date. Defaults to the current time. */
  now?: string | Date;
  /** `{{author}}` — a display name. */
  author?: string;
  /** `{{project}}` — a project name. */
  project?: string;
  /** `{{parent}}` — the parent page's title. */
  parent?: string;
  /**
   * Display labels for `user`/`page` values, keyed by id. Resolved by the
   * caller (the API looks them up inside the workspace); an id with no label
   * renders as nothing, so a foreign or invented id never reaches the page.
   */
  labels?: Record<string, string>;
}

/** `{{ name }}`, optionally escaped as `\{{ name }}`. */
const PLACEHOLDER_RE = /(\\)?\{\{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*\}\}/g;

const BCP47: Record<Locale, string> = { en: 'en-GB', ru: 'ru-RU' };

/**
 * A date the way `apps/web/src/lib/format.ts#formatDate` writes one, pinned to
 * UTC: a template rendered on the server and previewed in a browser in another
 * zone must produce the same day.
 */
export function formatTemplateDate(value: string | Date, locale: Locale): string {
  const at = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(at.getTime())) return typeof value === 'string' ? value : '';
  return new Intl.DateTimeFormat(BCP47[locale] ?? BCP47.en, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** The placeholder names a template text references, declared or not, escapes excluded. */
export function referencedPlaceholders(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    if (!match[1]) names.add(match[2]);
  }
  return [...names];
}

/**
 * Required placeholders the caller left blank, in declaration order. A
 * `user`/`page` value that is not an id counts as blank: it could only ever
 * render as nothing.
 */
export function missingRequiredPlaceholders(meta: TemplateMeta, values: TemplateValues | undefined): string[] {
  const missing: string[] = [];
  for (const p of meta.placeholders) {
    if (!p.required) continue;
    const value = values?.[p.name]?.trim() ?? '';
    if (!value || ((p.kind === 'user' || p.kind === 'page') && !isUuid(value))) missing.push(p.name);
  }
  return missing;
}

type Surface = 'body' | 'plain' | 'key';

function renderValue(
  placeholder: TemplatePlaceholder,
  raw: string | undefined,
  ctx: TemplateRenderContext,
  surface: Surface,
): string {
  const value = raw?.trim() ?? '';
  if (!value) return '';
  switch (placeholder.kind) {
    case 'date':
      return formatTemplateDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value, ctx.locale);
    case 'user': {
      const label = isUuid(value) ? ctx.labels?.[value] : undefined;
      if (!label) return '';
      // The editor's own encoding (UserMention), so the chip round-trips.
      return surface === 'body' ? `<span data-kn-user="${value}">@${escapeHtml(label)}</span>` : label;
    }
    case 'page': {
      const label = isUuid(value) ? ctx.labels?.[value] : undefined;
      if (!label) return '';
      // The editor's own encoding (DocMention).
      return surface === 'body' ? `<a href="/documents/${value}" data-kn-mention="1">${escapeHtml(label)}</a>` : label;
    }
    case 'entity':
      return surface === 'key' ? normalizeEntityKey(value) : value;
    default:
      return value;
  }
}

function systemValue(name: SystemPlaceholder, ctx: TemplateRenderContext): string {
  switch (name) {
    case 'title':
      return ctx.title;
    case 'date':
      return formatTemplateDate(ctx.now ?? new Date(), ctx.locale);
    case 'author':
      return ctx.author ?? '';
    case 'project':
      return ctx.project ?? '';
    case 'parent':
      return ctx.parent ?? '';
  }
}

function substitute(
  text: string,
  meta: TemplateMeta,
  values: TemplateValues | undefined,
  ctx: TemplateRenderContext,
  surface: Surface,
): string {
  const declared = new Map(meta.placeholders.map((p) => [p.name, p]));
  return text.replace(PLACEHOLDER_RE, (match: string, escaped: string | undefined, name: string) => {
    // `\{{x}}` is how a template writes a literal `{{x}}`.
    if (escaped) return match.slice(1);
    const placeholder = declared.get(name);
    if (placeholder) return renderValue(placeholder, values?.[name], ctx, surface);
    if ((SYSTEM_PLACEHOLDERS as readonly string[]).includes(name)) {
      return systemValue(name as SystemPlaceholder, ctx);
    }
    // Only declared names are substituted, so an API-spec template can show
    // Handlebars or Mustache examples without escaping every one of them.
    return match;
  });
}

/** The body with every system and declared placeholder filled in. */
export function renderTemplate(
  body: string,
  meta: TemplateMeta,
  values: TemplateValues | undefined,
  ctx: TemplateRenderContext,
): string {
  return substitute(body, meta, values, ctx, 'body');
}

/** The created page's title: the pattern rendered, or the title as typed. */
export function renderTemplateTitle(
  meta: TemplateMeta,
  values: TemplateValues | undefined,
  ctx: TemplateRenderContext,
): string {
  if (!meta.titlePattern?.trim()) return ctx.title;
  const rendered = substitute(meta.titlePattern, meta, values, ctx, 'plain').replace(/\s+/g, ' ').trim();
  return rendered || ctx.title;
}

function renderPlain(
  value: unknown,
  meta: TemplateMeta,
  values: TemplateValues | undefined,
  ctx: TemplateRenderContext,
  surface: Surface,
): unknown {
  if (typeof value === 'string') return substitute(value, meta, values, ctx, surface);
  if (Array.isArray(value)) return value.map((v) => renderPlain(v, meta, values, ctx, surface));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        // A relation target is an entity key wherever it appears.
        renderPlain(v, meta, values, ctx, k === 'target' || k === 'targetKey' || k === 'key' ? 'key' : surface),
      ]),
    );
  }
  return value;
}

function relationTargetOf(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return '';
  const { target, targetKey } = entry as { target?: unknown; targetKey?: unknown };
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object' && typeof (target as { key?: unknown }).key === 'string') {
    return (target as { key: string }).key;
  }
  return typeof targetKey === 'string' ? targetKey : '';
}

/**
 * The page's frontmatter: placeholders filled in every string, `user`/`page`
 * values as their plain labels, entity values folded wherever they are a
 * relation target. A tag or relation whose placeholder was left blank is
 * dropped rather than written as an empty key. `template:` is never passed in
 * — the caller has already stripped it.
 */
export function renderTemplateFrontmatter(
  data: Record<string, unknown>,
  meta: TemplateMeta,
  values: TemplateValues | undefined,
  ctx: TemplateRenderContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const rendered = renderPlain(value, meta, values, ctx, 'plain');
    if (Array.isArray(rendered) && Array.isArray(value)) {
      out[key] = rendered.filter((entry) => {
        if (typeof entry === 'string') return entry.trim() !== '';
        if (entry && typeof entry === 'object' && 'type' in (entry as object)) {
          // `service:{{name}}` with no name is `service:` — a key with no entity.
          const target = relationTargetOf(entry).trim();
          return target !== '' && !target.endsWith(':');
        }
        return true;
      });
    } else {
      out[key] = rendered;
    }
  }
  return out;
}

// --- writing a source -----------------------------------------------------------

/** What an editor holds of a template: the meta block, the inherited frontmatter and the body. */
export interface TemplateSourceFields {
  meta: TemplateMeta;
  tags: string[];
  relations: TemplateRelationDefault[];
  /** Frontmatter keys the editor does not model, re-emitted verbatim. `tags`/`relations`/`template` here are ignored. */
  other?: Record<string, unknown>;
  body: string;
}

/** Keys `composeTemplateSource` writes itself, under any spelling ingestion accepts. */
function isModelledKey(key: string): boolean {
  const folded = key.normalize('NFC').trim().toLowerCase();
  return folded === 'template' || folded === 'tags' || folded === 'relations' || FRONTMATTER_KEY_ALIASES[folded] !== undefined;
}

/**
 * The markdown source a template is stored as — the inverse of the API's
 * `parseTemplateSource`, so an editor with a form instead of a YAML box can
 * still write one.
 *
 * Every scalar is emitted as JSON, which is valid YAML flow style: no YAML
 * emitter is needed, and a `{{placeholder}}` or a colon in a title pattern is
 * always quoted. The `template:` block is laid out one field — and one
 * placeholder — per line, so a version diff shows what actually changed.
 */
export function composeTemplateSource(fields: TemplateSourceFields): string {
  const { meta } = fields;
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fields.other ?? {})) {
    if (value === undefined || isModelledKey(key)) continue;
    lines.push(`${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  }
  const tags = fields.tags.map((t) => t.trim()).filter(Boolean);
  if (tags.length > 0) lines.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  const relations = fields.relations.filter((r) => r.type.trim() && r.target.trim());
  if (relations.length > 0) {
    lines.push('relations:');
    for (const r of relations) {
      lines.push(`  - type: ${JSON.stringify(r.type.trim())}`);
      lines.push(`    target: ${JSON.stringify(r.target.trim())}`);
    }
  }
  lines.push('template:');
  lines.push(`  category: ${JSON.stringify(meta.category)}`);
  if (meta.titlePattern?.trim()) lines.push(`  titlePattern: ${JSON.stringify(meta.titlePattern.trim())}`);
  if (meta.description?.trim()) lines.push(`  description: ${JSON.stringify(meta.description.trim())}`);
  if (meta.placeholders.length > 0) {
    lines.push('  placeholders:');
    for (const p of meta.placeholders) {
      const entry: TemplatePlaceholder = {
        name: p.name.trim(),
        ...(p.label?.trim() ? { label: p.label.trim() } : {}),
        kind: p.kind,
        ...(p.required ? { required: true } : {}),
        ...(p.hint?.trim() ? { hint: p.hint.trim() } : {}),
      };
      lines.push(`    - ${JSON.stringify(entry)}`);
    }
  }
  if (meta.aiInstructions?.trim()) lines.push(`  aiInstructions: ${JSON.stringify(meta.aiInstructions.trim())}`);
  lines.push('---', '');
  return `${lines.join('\n')}${fields.body.replace(/^\n+/, '')}`;
}

/**
 * Placeholders a template text uses but does not declare yet, appended to the
 * ones it does (which are kept as they are, used or not — removing one is the
 * author's call). A name used as a relation target is offered as an `entity`,
 * since that is where its value is folded into a key; the rest start as `text`.
 * System names are never declared: the parser refuses a declared `title`.
 */
export function detectPlaceholders(
  text: { body: string; tags?: readonly string[]; relations?: readonly TemplateRelationDefault[] },
  declared: readonly TemplatePlaceholder[] = [],
): TemplatePlaceholder[] {
  const known = new Set<string>([...SYSTEM_PLACEHOLDERS, ...declared.map((p) => p.name)]);
  const entities = new Set((text.relations ?? []).flatMap((r) => referencedPlaceholders(r.target)));
  const found = [
    ...referencedPlaceholders(text.body),
    ...(text.tags ?? []).flatMap((t) => referencedPlaceholders(t)),
    ...entities,
  ];
  const out = [...declared];
  for (const name of found) {
    if (known.has(name) || !TEMPLATE_PLACEHOLDER_NAME_RE.test(name)) continue;
    known.add(name);
    out.push({ name, kind: entities.has(name) ? 'entity' : 'text' });
  }
  return out;
}
