import type { Locale } from '@knowledge/contracts/core';
import type { DocumentCategory } from '@knowledge/contracts/documents';
import type { TemplateRef } from '@knowledge/contracts/templates';
import { BUILT_IN_AGENT_KEYS, INTERVIEW_MAX_OPTIONS, INTERVIEW_MAX_QUESTIONS, INTERVIEW_MAX_ROUNDS } from '@knowledge/contracts/ai';
import type { InterviewAnswer, InterviewRound, ModelTier, StyleRule } from '@knowledge/contracts/ai';
import type { WorkflowGraph, WorkflowTrigger } from '@knowledge/contracts/workflows';
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

/**
 * One level of a methodology's work (#1121), in order: intent before rules,
 * question before decision. A page's level is derived from its template, never
 * stored.
 */
export interface BlueprintLevel {
  /** Slug, unique within the blueprint. */
  key: string;
  name: BlueprintText;
  description?: BlueprintText;
  /** Pages made from these templates sit at this level. */
  templateRefs: TemplateRef[];
  /** The default agent at this level: a built-in key or one of the blueprint's `agents`. */
  agentKey?: string;
  /** Added to the chat prompt at this level. Trusted prompt text, so only a workspace admin may write it. */
  guidance?: BlueprintText;
}

export interface BlueprintWorkflow {
  name: string;
  description?: string;
  graph: WorkflowGraph;
  trigger?: WorkflowTrigger;
}

/** An agent a methodology brings, as a custom agent it owns. */
export interface BlueprintAgent {
  /** Slug; never a built-in agent's key. */
  key: string;
  name: string;
  description?: string;
  instructions: string;
  /** Tool names from the assistant registry. */
  tools?: string[];
  /** The weakest model class it should run on; unset = whatever the purpose routes. */
  minTier?: ModelTier;
}

export interface Blueprint {
  name: BlueprintText;
  description?: BlueprintText;
  /** An emoji. */
  icon?: string;
  tree: BlueprintNode[];
  conventions?: BlueprintConventions;
  /** A blueprint with levels, workflows or agents is a methodology (#1121). */
  levels?: BlueprintLevel[];
  workflows?: BlueprintWorkflow[];
  agents?: BlueprintAgent[];
}

/**
 * The stored key of a methodology's own agent (#1127): the declared key plus
 * the blueprint's short id, so it never collides with a workspace agent of
 * the same key. A built-in key is itself — a level may name one directly.
 */
export function ownedAgentKey(key: string, blueprintId: string): string {
  return (BUILT_IN_AGENT_KEYS as readonly string[]).includes(key) ? key : `${key}-${blueprintId.slice(0, 8)}`;
}

/** A blueprint that declares levels, workflows or agents: what the UI calls a methodology (#1121). */
export function isMethodology(blueprint: Blueprint): boolean {
  return Boolean(blueprint.levels?.length || blueprint.workflows?.length || blueprint.agents?.length);
}

/**
 * The level a page made from `templateRef` sits at in a methodology (#1121):
 * the first level listing that template, or null. Derived, never stored, so
 * switching a project's methodology re-levels its pages without a write.
 */
export function levelOf(templateRef: string | null | undefined, levels: readonly BlueprintLevel[] | undefined): BlueprintLevel | null {
  if (!templateRef) return null;
  return levels?.find((level) => level.templateRefs.includes(templateRef)) ?? null;
}

export const BUILT_IN_BLUEPRINT_KEYS = ['discovery', 'construction', 'code-product', 'service-docs', 'blank'] as const;
export type BuiltInBlueprintKey = (typeof BUILT_IN_BLUEPRINT_KEYS)[number];

export function isBuiltInBlueprintKey(value: unknown): value is BuiltInBlueprintKey {
  return (BUILT_IN_BLUEPRINT_KEYS as readonly unknown[]).includes(value);
}

/** Pages one scaffold may write; the tree depth it may nest. */
export const BLUEPRINT_MAX_PAGES = 200;
export const BLUEPRINT_MAX_DEPTH = 5;
/** A methodology's levels, workflows and agents (#1121). */
export const BLUEPRINT_MAX_LEVELS = 20;
export const BLUEPRINT_MAX_WORKFLOWS = 20;
export const BLUEPRINT_MAX_AGENTS = 20;
/** Per language, for a level's guidance. */
export const BLUEPRINT_LEVEL_GUIDANCE_MAX = 4_000;

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

/**
 * One blueprint a project can start from. Built-ins come first, in their fixed
 * order, with the workspace's override applied; then saved ones, newest first.
 */
export interface BlueprintEntry {
  /** What `POST /v1/projects/scaffold` takes as `blueprintKey`: the built-in key, or a saved blueprint's id. */
  key: string;
  builtIn: boolean;
  /** The workspace's row: a saved blueprint, or its override of a built-in. Null for an untouched built-in. */
  id: string | null;
  /** False = a hidden built-in (or a switched-off saved one); listed only with `includeDisabled`. */
  enabled: boolean;
  /** The row's current version; 0 for a built-in served from code. */
  version: number;
  blueprint: Blueprint;
}

export interface ListBlueprintsResponse {
  blueprints: BlueprintEntry[];
}

// --- POST /v1/blueprints/derive -------------------------------------------------------

/**
 * A blueprint read off an existing project: its tree to depth 3 (titles and
 * headings only, never page text), numbered or same-shaped leaves folded into
 * collections, its templates as conventions, and — drafted by the `scaffolder`
 * when `assistant` is on — a styleguide and per-page guidance.
 */
export interface DeriveBlueprintResponse {
  blueprint: Blueprint;
  /** The source project's glossary, offered unchecked. Empty unless the source is in the same workspace. */
  glossary: BlueprintGlossaryTerm[];
  /** Whether the model drafted the styleguide and guidance; false = rules only. */
  drafted: boolean;
}

// --- POST /v1/blueprints/generate -----------------------------------------------------

/** The Describe it interview's caps and shapes (#731) are the shared interview's (`@knowledge/contracts/ai`). */
export const BLUEPRINT_INTERVIEW_MAX_ROUNDS = INTERVIEW_MAX_ROUNDS;
export const BLUEPRINT_INTERVIEW_MAX_QUESTIONS = INTERVIEW_MAX_QUESTIONS;
export const BLUEPRINT_INTERVIEW_MAX_OPTIONS = INTERVIEW_MAX_OPTIONS;
export type BlueprintInterviewAnswer = InterviewAnswer;
export type BlueprintInterviewRound = InterviewRound;

/**
 * Describe it's reply (#716, #731). `done`: the blueprint the `scaffolder`
 * drafted (tree, guidance, styleguide, through the one schema) and the glossary
 * terms it read off the person's words, offered ticked. `asking`: one more
 * round of questions, with the outline so far (titles only) and the candidate
 * terms. Without an `interview` in the request the reply is always `done`.
 * Nothing is written either way; the wizard takes a `done` to Shape.
 */
export type GenerateBlueprintResponse =
  | { status: 'done'; blueprint: Blueprint; glossary: BlueprintGlossaryTerm[] }
  | { status: 'asking'; round: BlueprintInterviewRound; outline: BlueprintNode[]; terms: BlueprintGlossaryTerm[] };

// --- /v1/projects/:id/methodology (#1121) ------------------------------------------

/** A project's methodology: the blueprint it links, live. */
export interface ProjectMethodologyResponse {
  projectId: string;
  /** Null: the project has none, and reads only its own and workspace-wide conventions. */
  methodology: {
    /** As `GET /v1/blueprints` lists it: a built-in key or a saved blueprint's id. */
    key: string;
    name: BlueprintText;
    icon: string | null;
    builtIn: boolean;
    /** False: archived. Hidden from pickers; this project still reads it. */
    enabled: boolean;
    levels: BlueprintLevel[];
  } | null;
}

/** `GET /v1/projects/:id/levels` (#1126): the project's methodology levels in order, with the pages at each. Empty without one. */
export interface ProjectLevelsResponse {
  projectId: string;
  levels: {
    key: string;
    /** In the reader's language. */
    name: string;
    description: string | null;
    /** The level's default agent, if it names one. */
    agentKey: string | null;
    /** Pages the reader can see at this level. */
    pages: number;
  }[];
}

/** A section of the methodology's tree the project lacks, matched by title. */
export interface MethodologyPreviewSection {
  /** The node's index path in the methodology's tree: `2` (top level) or `2.0` (one level down). */
  id: string;
  title: string;
  /** The existing page it would go under; null for a top-level section. */
  parentTitle: string | null;
  /** Pages it writes, itself included. */
  pages: number;
}

/**
 * What linking `blueprintKey` would do (`GET …/methodology/preview`): nothing is
 * written. Sections are offered for the user to confirm; pages are never
 * deleted, moved or edited. `levels` counts the project's pages each level of
 * the new methodology would give a level.
 */
export interface MethodologyPreviewResponse {
  blueprintKey: string;
  sections: MethodologyPreviewSection[];
  levels: { key: string; name: string; pages: number }[];
}

// --- POST /v1/projects/scaffold (the body is ScaffoldProjectDto) ------------------

export interface ScaffoldProjectResponse {
  project: ProjectSummary;
  pageCount: number;
}
