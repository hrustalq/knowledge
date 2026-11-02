import type { Locale } from '@knowledge/contracts/core';
import type { DocumentCategory } from '@knowledge/contracts/documents';
import type { TemplateRef } from '@knowledge/contracts/templates';
import type { StyleRule } from '@knowledge/contracts/ai';
import type { ProjectSummary } from '@knowledge/contracts/identity';

// ---------------------------------------------------------------------------
// Project blueprints (#716).
//
// A blueprint is a reusable description of a project: a page tree plus the
// conventions the project starts with. Scaffolding writes it in one
// transaction (`POST /v1/projects/scaffold`). Built-ins are code
// (`apps/api/src/blueprints/built-in/`), never seeded rows.
//
// These are shapes only. The parse is API-side (zod, `blueprint.schema.ts`):
// this package carries no runtime dependency, the wiki-steering precedent.
// ---------------------------------------------------------------------------

/** Text a blueprint carries per language. A missing language falls back to any present one. */
export type BlueprintText = Partial<Record<Locale, string>>;

/**
 * A page whose future children follow a rule (a "collection"): new children
 * start from `childTemplateRef` and are titled by `childTitlePattern`.
 * Lands on `documents.child_template_ref` / `child_title_pattern`.
 */
export interface BlueprintCollection {
  childTemplateRef?: TemplateRef;
  /** A title prefix: `ADR {{n:4}}: `, `{{n:2}} — `, `{{date}} session`. See `nextChildTitle`. */
  childTitlePattern?: BlueprintText;
}

export interface BlueprintNode {
  title: BlueprintText;
  category?: DocumentCategory;
  /** The page starts as this template's skeleton. A collection's children default to its `childTemplateRef`. */
  templateRef?: TemplateRef;
  /** A markdown heading skeleton, used when there is no template. */
  body?: BlueprintText;
  /** What belongs on the page, shown as a note above the skeleton. */
  guidance?: BlueprintText;
  collection?: BlueprintCollection;
  /** Under a collection, these are its initial items, titled by its pattern. */
  children?: BlueprintNode[];
}

export interface BlueprintTemplate {
  name: string;
  /** Template markdown, `template:` frontmatter included (`parseTemplateSource`). */
  source: string;
  description?: string;
  icon?: string;
}

export interface BlueprintGlossaryTerm {
  term: string;
  definition: string;
  aliases?: string[];
}

export interface BlueprintConventions {
  /** The project's own styleguide. Trusted prompt text, so only a workspace admin may scaffold one. */
  styleguide?: { description?: string; rules: StyleRule[] };
  /** Created as version-1 project templates. */
  templates?: BlueprintTemplate[];
  glossary?: BlueprintGlossaryTerm[];
}

export interface Blueprint {
  name: BlueprintText;
  description?: BlueprintText;
  /** An emoji. */
  icon?: string;
  tree: BlueprintNode[];
  conventions?: BlueprintConventions;
}

export const BUILT_IN_BLUEPRINT_KEYS = ['discovery', 'code-product', 'service-docs', 'blank'] as const;
export type BuiltInBlueprintKey = (typeof BUILT_IN_BLUEPRINT_KEYS)[number];

/** Pages one scaffold may write; the tree depth it may nest. */
export const BLUEPRINT_MAX_PAGES = 200;
export const BLUEPRINT_MAX_DEPTH = 5;

/** `text` in `locale`, else any language it has, else ''. As written: a title pattern's trailing space matters. */
export function blueprintText(text: BlueprintText | undefined, locale: Locale): string {
  if (!text) return '';
  return [text[locale], ...Object.values(text)].find((v) => v?.trim()) ?? '';
}

// --- numbering ------------------------------------------------------------------

const NUMBER_TOKEN = /\{\{\s*n(?::(\d))?\s*\}\}/;
const DATE_TOKEN = /\{\{\s*date\s*\}\}/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The title a new child of a collection starts with.
 *
 * `{{n:W}}` is the next number, zero-padded to W digits: the highest number
 * already in that position among `siblings` plus one (gaps are kept, never
 * refilled). `{{date}}` is today, ISO, so titles sort. With `title`, it
 * follows the rendered pattern after one space.
 *
 * `nextChildTitle('ADR {{n:4}}: ', ['ADR 0007: Queue'])` → `ADR 0008: `.
 */
export function nextChildTitle(pattern: string, siblings: readonly string[], title?: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const token = NUMBER_TOKEN.exec(pattern);
  let rendered = pattern.replace(DATE_TOKEN, date);
  if (token) {
    const width = Number(token[1] ?? 1);
    const [before, after] = [pattern.slice(0, token.index), pattern.slice(token.index + token[0].length)];
    const literal = (s: string) => escapeRe(s.replace(DATE_TOKEN, '\u0000')).replace(/\u0000/g, '\\d{4}-\\d{2}-\\d{2}');
    const re = new RegExp(`^${literal(before)}(\\d+)${literal(after.trimEnd())}`);
    const max = Math.max(0, ...siblings.map((s) => Number(re.exec(s)?.[1] ?? 0)));
    rendered = rendered.replace(NUMBER_TOKEN, String(max + 1).padStart(width, '0'));
  }
  const name = title?.trim();
  return name ? `${rendered.trimEnd()} ${name}` : rendered;
}

// --- GET /v1/blueprints ------------------------------------------------------------

export interface BlueprintEntry {
  key: BuiltInBlueprintKey;
  blueprint: Blueprint;
}

export interface ListBlueprintsResponse {
  blueprints: BlueprintEntry[];
}

// --- POST /v1/projects/scaffold (the body is ScaffoldProjectDto) ------------------

export interface ScaffoldProjectResponse {
  project: ProjectSummary;
  pageCount: number;
}
