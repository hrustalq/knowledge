import matter from 'gray-matter';
import {
  DOCUMENT_CATEGORIES,
  FRONTMATTER_KEY_ALIASES,
  SYSTEM_PLACEHOLDERS,
  TEMPLATE_PLACEHOLDER_KINDS,
  TEMPLATE_PLACEHOLDER_NAME_RE,
  referencedPlaceholders,
  type DocumentCategory,
  type TemplateMeta,
  type TemplatePlaceholder,
  type TemplatePlaceholderKind,
  type TemplateRelationDefault,
} from '@knowledge/contracts';
import { normalizeRelation, readFrontmatterTags } from '../common/relations.js';
import { TEMPLATE_MAX_PLACEHOLDERS, TEMPLATE_MAX_SOURCE_CHARS } from './templates.constants.js';

/**
 * Reading a template's markdown source (issue #69).
 *
 * A leaf with no Nest imports: the templates service validates on write, and
 * the worker's workflow executors will parse the same source to draft against.
 *
 * The rule this file exists to enforce: **a template the graph would refuse is
 * refused on save**, not when a page is later created from it. A relation whose
 * type is not authorable, or whose target names a placeholder the template
 * never declared, is an error here — the lesson from `WorkflowStepProduces`,
 * where the same mistake surfaced only after a person had approved a draft.
 */

export interface ParsedTemplateSource {
  meta: TemplateMeta;
  /** Frontmatter with the reserved `template:` key removed — what the page inherits. */
  data: Record<string, unknown>;
  body: string;
  tags: string[];
  relations: TemplateRelationDefault[];
}

/** Why a source was refused; mapped onto an `error.template.*` message by the service. */
export class TemplateSourceError extends Error {
  constructor(
    readonly code: 'tooLong' | 'invalidFrontmatter' | 'invalidMeta' | 'tooManyPlaceholders' | 'invalidPlaceholder' | 'invalidRelation',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

const RESERVED_KEY = 'template';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPlaceholders(raw: unknown): TemplatePlaceholder[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TemplateSourceError('invalidMeta', 'placeholders must be a list');
  if (raw.length > TEMPLATE_MAX_PLACEHOLDERS) {
    throw new TemplateSourceError('tooManyPlaceholders', String(TEMPLATE_MAX_PLACEHOLDERS));
  }
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new TemplateSourceError('invalidPlaceholder', String(entry));
    const p = entry as Record<string, unknown>;
    const name = asString(p.name) ?? '';
    if (!TEMPLATE_PLACEHOLDER_NAME_RE.test(name)) throw new TemplateSourceError('invalidPlaceholder', name || '?');
    // A declared `title` would shadow the system value the page title is built from.
    if ((SYSTEM_PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new TemplateSourceError('invalidPlaceholder', name);
    }
    if (seen.has(name)) throw new TemplateSourceError('invalidPlaceholder', name);
    seen.add(name);
    const kind = (asString(p.kind) ?? 'text') as TemplatePlaceholderKind;
    if (!TEMPLATE_PLACEHOLDER_KINDS.includes(kind)) throw new TemplateSourceError('invalidPlaceholder', `${name}: ${kind}`);
    const label = asString(p.label);
    const hint = asString(p.hint);
    return {
      name,
      kind,
      ...(label ? { label } : {}),
      ...(p.required === true ? { required: true } : {}),
      ...(hint ? { hint } : {}),
    };
  });
}

function readMeta(raw: unknown): TemplateMeta {
  if (raw === undefined || raw === null) return { category: 'other', placeholders: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TemplateSourceError('invalidMeta', 'the template: key must be a mapping');
  }
  const m = raw as Record<string, unknown>;
  const category = (asString(m.category) ?? 'other') as DocumentCategory;
  if (!DOCUMENT_CATEGORIES.includes(category)) throw new TemplateSourceError('invalidMeta', `category ${category}`);
  const titlePattern = asString(m.titlePattern);
  const description = asString(m.description);
  const aiInstructions = asString(m.aiInstructions);
  return {
    category,
    placeholders: readPlaceholders(m.placeholders),
    ...(titlePattern ? { titlePattern } : {}),
    ...(description ? { description } : {}),
    ...(aiInstructions ? { aiInstructions } : {}),
  };
}

/** The raw `relations:` list under whichever spelling the page uses, as `readFrontmatterRelations` reads it. */
function rawRelations(data: Record<string, unknown>): unknown[] {
  const value =
    data.relations !== undefined
      ? data.relations
      : Object.entries(data).find(
          ([key]) => FRONTMATTER_KEY_ALIASES[key.normalize('NFC').trim().toLowerCase()] === 'relations',
        )?.[1];
  return Array.isArray(value) ? value : [];
}

function targetText(entry: Record<string, unknown>): string {
  const { target, targetKey } = entry;
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object' && typeof (target as { key?: unknown }).key === 'string') {
    return (target as { key: string }).key;
  }
  return typeof targetKey === 'string' ? targetKey : '';
}

function readRelations(data: Record<string, unknown>, meta: TemplateMeta): TemplateRelationDefault[] {
  const known = new Set<string>([...SYSTEM_PLACEHOLDERS, ...meta.placeholders.map((p) => p.name)]);
  return rawRelations(data).map((entry) => {
    // The same normalizer ingestion runs, so "valid here" and "an edge later" agree.
    const relation = normalizeRelation(entry);
    if (!relation) throw new TemplateSourceError('invalidRelation', JSON.stringify(entry));
    const target = targetText(entry as Record<string, unknown>);
    for (const name of referencedPlaceholders(target)) {
      if (!known.has(name)) throw new TemplateSourceError('invalidRelation', `{{${name}}}`);
    }
    return { type: relation.type, target };
  });
}

/**
 * Parse and validate a template source. Throws `TemplateSourceError`.
 *
 * gray-matter caches parses by input string and hands back the cached object,
 * so the frontmatter is cloned before the reserved key is deleted from it —
 * otherwise the second parse of the same built-in would find no `template:`.
 */
export function parseTemplateSource(source: string): ParsedTemplateSource {
  if (source.length > TEMPLATE_MAX_SOURCE_CHARS) {
    throw new TemplateSourceError('tooLong', String(TEMPLATE_MAX_SOURCE_CHARS));
  }
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(source);
  } catch (e) {
    throw new TemplateSourceError('invalidFrontmatter', (e as Error).message.split('\n')[0]);
  }
  const data = structuredClone((parsed.data ?? {}) as Record<string, unknown>);
  const meta = readMeta(data[RESERVED_KEY]);
  delete data[RESERVED_KEY];
  return {
    meta,
    data,
    body: parsed.content.replace(/^\n+/, ''),
    tags: readFrontmatterTags(data),
    relations: readRelations(data, meta),
  };
}
