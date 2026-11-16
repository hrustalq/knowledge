import { z } from 'zod';
import type { TagsMatch } from './memory-facts.js';

export interface MentalModelTrigger {
  mode?: 'full' | 'delta';
  refresh_after_consolidation?: boolean;
  refresh_cron?: string | null;
  full_refresh_cron?: string | null;
  min_refresh_interval_seconds?: number | null;
  fact_types?: Array<'world' | 'experience' | 'observation'> | null;
  exclude_mental_models?: boolean;
  exclude_mental_model_ids?: string[] | null;
  tags_match?: TagsMatch | null;
  tag_groups?: unknown[] | null;
  include_chunks?: boolean | null;
  recall_max_tokens?: number | null;
  recall_chunks_max_tokens?: number | null;
  reflect_search_observations_max_tokens?: number | null;
  reflect_search_observations_include_entities?: boolean | null;
  budget?: 'low' | 'mid' | 'high' | null;
  response_schema?: Record<string, unknown> | null;
  keep_trace?: boolean;
}

export const DEFAULT_MENTAL_MODEL_TRIGGER: Required<MentalModelTrigger> = {
  mode: 'full',
  refresh_after_consolidation: false,
  refresh_cron: null,
  full_refresh_cron: null,
  min_refresh_interval_seconds: null,
  fact_types: null,
  exclude_mental_models: false,
  exclude_mental_model_ids: null,
  tags_match: null,
  tag_groups: null,
  include_chunks: null,
  recall_max_tokens: null,
  recall_chunks_max_tokens: null,
  reflect_search_observations_max_tokens: null,
  reflect_search_observations_include_entities: null,
  budget: null,
  response_schema: null,
  keep_trace: false,
};

export function mentalModelTrigger(value: unknown): MentalModelTrigger {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MentalModelTrigger : {};
}

export function mentalModelTriggerOutput(value: unknown): Required<MentalModelTrigger> {
  return { ...DEFAULT_MENTAL_MODEL_TRIGGER, ...mentalModelTrigger(value) };
}

export function validMentalModelId(id: string): boolean {
  return new TextEncoder().encode(id).length <= 192 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

export function validResponseSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties) || !Object.keys(properties).length) return false;
  const types = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
  return Object.values(properties).every((value) => value && typeof value === 'object' && !Array.isArray(value) && types.has(String((value as Record<string, unknown>).type)));
}

const CRON_LIMITS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function cronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const start = match[1] === '*' ? min : Number(match[1]);
    const end = match[2] === undefined ? match[1] === '*' ? max : start : Number(match[2]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (start < min || end > max || start > end || step < 1) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): Array<Set<number>> | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed = fields.map((field, i) => cronField(field, CRON_LIMITS[i]![0], CRON_LIMITS[i]![1]));
  return parsed.every((field): field is Set<number> => field !== null) ? parsed : null;
}

export function cronMatches(expression: string, at: Date): boolean {
  const fields = parseCron(expression);
  if (!fields) return false;
  const values = [at.getUTCMinutes(), at.getUTCHours(), at.getUTCDate(), at.getUTCMonth() + 1, at.getUTCDay()];
  const dayOfWeek = fields[4]!.has(values[4]!) || (values[4] === 0 && fields[4]!.has(7));
  const dayOfMonth = fields[2]!.has(values[2]!);
  const day = expression.trim().split(/\s+/);
  const daysMatch = day[2] !== '*' && day[4] !== '*' ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek;
  return fields[0]!.has(values[0]!) && fields[1]!.has(values[1]!) && fields[3]!.has(values[3]!) && daysMatch;
}

const DAY = 86_400_000;
/** Four years back, so a 29 February schedule still finds its last firing. */
const CRON_LOOKBACK_DAYS = 1462;

/** The latest minute at or before `now` the expression fires, or null within the lookback. */
export function previousCronFire(expression: string, now: number): number | null {
  const fields = parseCron(expression);
  if (!fields) return null;
  const raw = expression.trim().split(/\s+/);
  const either = raw[2] !== '*' && raw[4] !== '*';
  const hours = [...fields[1]!].sort((a, b) => b - a);
  const minutes = [...fields[0]!].sort((a, b) => b - a);
  const today = Math.floor(now / DAY) * DAY;
  for (let i = 0; i <= CRON_LOOKBACK_DAYS; i++) {
    const day = new Date(today - i * DAY);
    const dow = day.getUTCDay();
    const dayOfWeek = fields[4]!.has(dow) || (dow === 0 && fields[4]!.has(7));
    const dayOfMonth = fields[2]!.has(day.getUTCDate());
    if (!fields[3]!.has(day.getUTCMonth() + 1) || !(either ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek)) continue;
    for (const hour of hours) for (const minute of minutes) {
      const at = day.getTime() + hour * 3_600_000 + minute * 60_000;
      if (at <= now) return at;
    }
  }
  return null;
}

/**
 * Due when the expression fired anywhere in (last, now] — a sweep that misses
 * the exact minute still runs it. With no last run, only the current minute counts.
 */
export function cronDue(expression: string | null | undefined, now: number, last: Date | null): boolean {
  if (!expression) return false;
  const fired = previousCronFire(expression, now);
  if (fired === null) return false;
  return last ? fired > last.getTime() : fired === Math.floor(now / 60_000) * 60_000;
}

/** What a model's content is built from besides its query; a change makes it stale and the next refresh full. */
export function mentalModelScope(model: { tags: string[]; trigger: unknown }): string {
  const trigger = mentalModelTriggerOutput(model.trigger);
  const tags = [...new Set(model.tags)].sort();
  return JSON.stringify({
    tags,
    tags_match: trigger.tags_match ?? (tags.length ? 'all_strict' : 'any'),
    fact_types: trigger.fact_types?.length ? [...new Set(trigger.fact_types)].sort() : null,
  });
}

export interface MentalModelBlock {
  id: string;
  text: string;
}

export interface MentalModelSection {
  id: string;
  heading: string | null;
  blocks: MentalModelBlock[];
}

export interface MentalModelDocument {
  sections: MentalModelSection[];
}

const documentSchema = z.object({
  sections: z.array(z.object({
    id: z.string().min(1),
    heading: z.string().nullable(),
    blocks: z.array(z.object({ id: z.string().min(1), text: z.string() })),
  })),
});

export function readMentalModelDocument(value: unknown): MentalModelDocument | null {
  const parsed = documentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function blocksOf(body: string): string[] {
  const blocks: string[] = [];
  let start = 0;
  let fence = '';
  for (const match of body.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0];
    if (!line) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!;
      else if (marker[0] === fence) fence = '';
    }
    if (!fence && /^\s*(?:\n|$)/.test(line)) {
      const end = match.index! + line.length;
      if (body.slice(start, end).trim()) {
        blocks.push(body.slice(start, end));
        start = end;
      }
    }
  }
  if (start < body.length) blocks.push(body.slice(start));
  return blocks.filter(Boolean);
}

export function parseMentalModelDocument(content: string): MentalModelDocument {
  const headings = [...content.matchAll(/^#{1,6}[ \t]+[^\n]*(?:\n|$)/gm)];
  const sections: MentalModelSection[] = [];
  const add = (heading: string | null, body: string) => {
    if (heading === null && !body) return;
    const id = `s${sections.length + 1}`;
    sections.push({ id, heading, blocks: blocksOf(body).map((text, i) => ({ id: `${id}-b${i + 1}`, text })) });
  };
  if (!headings.length) add(null, content);
  else {
    add(null, content.slice(0, headings[0]!.index));
    headings.forEach((heading, i) => {
      const start = heading.index! + heading[0].length;
      add(heading[0], content.slice(start, headings[i + 1]?.index ?? content.length));
    });
  }
  return { sections };
}

export function renderMentalModelDocument(document: MentalModelDocument): string {
  return document.sections.map((section) => (section.heading ?? '') + section.blocks.map((block) => block.text).join('')).join('');
}

const deltaOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_section'), heading: z.string().min(1), blocks: z.array(z.string()).max(100).default([]) }),
  z.object({ op: z.literal('remove_section'), section_id: z.string() }),
  z.object({ op: z.literal('rename_section'), section_id: z.string(), heading: z.string().min(1) }),
  z.object({ op: z.literal('replace_section_blocks'), section_id: z.string(), blocks: z.array(z.string()).max(100) }),
  z.object({ op: z.literal('append_block'), section_id: z.string(), content: z.string() }),
  z.object({ op: z.literal('insert_block'), section_id: z.string(), after_block_id: z.string(), content: z.string() }),
  z.object({ op: z.literal('replace_block'), section_id: z.string(), block_id: z.string(), content: z.string() }),
  z.object({ op: z.literal('remove_block'), section_id: z.string(), block_id: z.string() }),
]);
export type DeltaOperation = z.infer<typeof deltaOperation>;

export function readDeltaOperations(raw: unknown): DeltaOperation[] | null {
  const parsed = z.object({ operations: z.array(deltaOperation).min(1).max(100) }).safeParse(raw);
  return parsed.success ? parsed.data.operations : null;
}

const nextId = (ids: string[], prefix: string) => `${prefix}${Math.max(0, ...ids.map((id) => Number(/(\d+)$/.exec(id)?.[1] ?? 0))) + 1}`;
const blockText = (text: string) => text.endsWith('\n\n') ? text : text.endsWith('\n') ? `${text}\n` : `${text}\n\n`;
const blockAfter = (previous: string, text: string) => `${previous.endsWith('\n\n') ? '' : previous.endsWith('\n') ? '\n' : '\n\n'}${blockText(text)}`;
const headingText = (heading: string, previous?: string | null) => {
  const line = heading.trimEnd();
  const withMarker = /^#{1,6}[ \t]+/.test(line) ? line : `${/^#{1,6}/.exec(previous ?? '')?.[0] ?? '##'} ${line}`;
  return `${withMarker}${previous?.endsWith('\n') ? '\n' : ''}`;
};

export function applyMentalModelDelta(current: MentalModelDocument, operations: DeltaOperation[]): {
  document: MentalModelDocument;
  applied: DeltaOperation[];
  skipped: Array<{ operation: DeltaOperation; reason: string }>;
} {
  const document = structuredClone(current);
  const applied: DeltaOperation[] = [];
  const skipped: Array<{ operation: DeltaOperation; reason: string }> = [];
  const sectionOf = (id: string) => document.sections.find((section) => section.id === id);
  for (const operation of operations) {
    if (operation.op === 'add_section') {
      const id = nextId(document.sections.map((section) => section.id), 's');
      document.sections.push({
        id,
        heading: headingText(operation.heading, '\n'),
        blocks: operation.blocks.map((text, i) => ({ id: `${id}-b${i + 1}`, text: blockText(text) })),
      });
      applied.push(operation);
      continue;
    }
    const section = sectionOf(operation.section_id);
    if (!section) {
      skipped.push({ operation, reason: 'section_not_found' });
      continue;
    }
    if (operation.op === 'remove_section') {
      document.sections.splice(document.sections.indexOf(section), 1);
    } else if (operation.op === 'rename_section') {
      section.heading = headingText(operation.heading, section.heading);
    } else if (operation.op === 'replace_section_blocks') {
      section.blocks = operation.blocks.map((text, i) => ({ id: `${section.id}-b${i + 1}`, text: blockText(text) }));
    } else {
      const index = 'block_id' in operation ? section.blocks.findIndex((block) => block.id === operation.block_id) : operation.op === 'insert_block' ? section.blocks.findIndex((block) => block.id === operation.after_block_id) : -1;
      if (operation.op !== 'append_block' && index < 0) {
        skipped.push({ operation, reason: 'block_not_found' });
        continue;
      }
      if (operation.op === 'append_block') {
        const previous = section.blocks.at(-1)?.text ?? section.heading ?? '';
        section.blocks.push({ id: nextId(section.blocks.map((block) => block.id), `${section.id}-b`), text: blockAfter(previous, operation.content) });
      } else if (operation.op === 'insert_block') {
        section.blocks.splice(index + 1, 0, { id: nextId(section.blocks.map((block) => block.id), `${section.id}-b`), text: blockAfter(section.blocks[index]!.text, operation.content) });
      } else if (operation.op === 'replace_block') {
        const previous = section.blocks[index]!;
        section.blocks[index] = { ...previous, text: `${/^\s*/.exec(previous.text)![0]}${blockText(operation.content)}` };
      } else if (operation.op === 'remove_block') {
        section.blocks.splice(index, 1);
      }
    }
    applied.push(operation);
  }
  return { document, applied, skipped };
}
