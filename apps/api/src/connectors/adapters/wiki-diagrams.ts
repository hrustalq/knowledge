import { z } from 'zod';
import type { CodeSymbol } from './code-symbols.js';
import type { ModuleEdges } from './import-resolver.js';

/**
 * Mermaid diagrams for the repo wiki (docs/features/46). Pure functions.
 *
 * The rule that makes these safe to put on a page is that **only this file
 * writes Mermaid**. Labels come from the repository (module names, symbol
 * names, a steering file) or from a model (sequence participants), and none of
 * it is ever spliced in as syntax: every label goes through `mermaidText`, node
 * ids are ours (`m0`, `C3`, `P1`), and the model's sequence answer is JSON this
 * file renders — the model never writes a Mermaid line. `lintMermaid` then
 * checks the output against the handful of line shapes these builders emit, so
 * a builder bug drops a diagram instead of shipping one. The web renders with
 * `securityLevel: 'strict'` and DOMPurify as the second line, not the first.
 */

const LABEL_MAX = 60;

/**
 * A label made inert: letters, digits and a short list of punctuation survive,
 * everything else becomes a space. A whitelist rather than a blacklist, because
 * Mermaid's own escapes (`#35;`), directives (`%%`), links (`click`) and HTML
 * labels are each a character the blacklist would have had to know about.
 */
export function mermaidText(text: string): string {
  const cleaned = text
    .replace(/[^\p{L}\p{N} ._\-/:@,+()'?!&=*]/gu, ' ')
    .replace(/\bclick\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '—';
  return cleaned.length > LABEL_MAX ? `${cleaned.slice(0, LABEL_MAX - 1)}…` : cleaned;
}

/** `mermaidText`, quoted — for node labels, where Mermaid takes `id["…"]`. */
export function mermaidLabel(text: string): string {
  return `"${mermaidText(text).replace(/:/g, ' ')}"`;
}

/** A type name as a parser reports one — `Base`, `pkg.Base`, `std::fmt::Display`. Anything else is not drawn. */
function isTypeName(name: string): boolean {
  return /^[\p{L}_$][\p{L}\p{N}_$.:]{0,79}$/u.test(name) && name.toLowerCase() !== 'click';
}

/** A member or identifier inside a class box: identifier characters only. */
function memberText(name: string): string | null {
  const cleaned = name.replace(/[^\p{L}\p{N}_$]/gu, '').slice(0, 40);
  return cleaned && cleaned.toLowerCase() !== 'click' ? cleaned : null;
}

// --- architecture -----------------------------------------------------------

export interface DiagramModule {
  key: string;
  name: string;
}

/**
 * `flowchart LR`: modules as boxes, cross-module imports as arrows, external
 * packages as rounded nodes. Modules come first in the node budget, the most
 * connected first; external packages fill what is left, the most shared first.
 * Null when there is nothing worth drawing (one module, no edges).
 */
export function architectureFlowchart(modules: DiagramModule[], edges: ModuleEdges, maxNodes: number): string | null {
  const degree = new Map(modules.map((m) => [m.key, 0]));
  for (const [from, row] of edges.internal) {
    for (const to of row.keys()) {
      degree.set(from, (degree.get(from) ?? 0) + 1);
      degree.set(to, (degree.get(to) ?? 0) + 1);
    }
  }
  const kept = [...modules]
    .sort((a, b) => (degree.get(b.key) ?? 0) - (degree.get(a.key) ?? 0) || a.key.localeCompare(b.key))
    .slice(0, Math.max(1, maxNodes));
  const ids = new Map(kept.map((m, i) => [m.key, `m${i}`]));

  const externalCounts = new Map<string, number>();
  for (const [from, set] of edges.external) {
    if (!ids.has(from)) continue;
    for (const pkg of set) externalCounts.set(pkg, (externalCounts.get(pkg) ?? 0) + 1);
  }
  // External packages used by one module only are that module's business, and
  // drawing them would bury the arrows between modules that the diagram is for.
  const room = Math.max(0, maxNodes - kept.length);
  const externals = [...externalCounts]
    .filter(([, count]) => count > 1 || kept.length === 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, room)
    .map(([pkg]) => pkg);
  const extIds = new Map(externals.map((pkg, i) => [pkg, `x${i}`]));

  const lines = ['flowchart LR'];
  for (const module of [...kept].sort((a, b) => a.key.localeCompare(b.key))) {
    lines.push(`  ${ids.get(module.key)}[${mermaidLabel(module.name)}]`);
  }
  for (const pkg of externals) lines.push(`  ${extIds.get(pkg)}([${mermaidLabel(pkg)}]):::ext`);

  const arrows: string[] = [];
  for (const [from, row] of edges.internal) {
    for (const to of row.keys()) {
      if (ids.has(from) && ids.has(to)) arrows.push(`  ${ids.get(from)} --> ${ids.get(to)}`);
    }
  }
  for (const [from, set] of edges.external) {
    for (const pkg of set) {
      if (ids.has(from) && extIds.has(pkg)) arrows.push(`  ${ids.get(from)} -.-> ${extIds.get(pkg)}`);
    }
  }
  if (arrows.length === 0) return null;
  lines.push(...arrows.sort());
  if (externals.length > 0) lines.push('  classDef ext fill:#f5f5f5,stroke:#999,stroke-dasharray:3 3');
  return lines.join('\n');
}

// --- class ------------------------------------------------------------------

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'type']);

/**
 * `classDiagram` for one module: its exported types with their members, and
 * the supertypes they name. The busiest types win the node budget; a
 * supertype from elsewhere is drawn as a bare box so the arrow has an end.
 * Null when the module exports no type with anything to show.
 */
export function moduleClassDiagram(symbols: CodeSymbol[], maxNodes: number): string | null {
  const types = symbols
    .filter((s) => s.exported && TYPE_KINDS.has(s.kind) && isTypeName(s.name))
    .filter((s) => (s.members?.length ?? 0) > 0 || (s.extends?.length ?? 0) > 0 || (s.implements?.length ?? 0) > 0)
    .sort((a, b) => (b.members?.length ?? 0) - (a.members?.length ?? 0) || a.name.localeCompare(b.name));
  if (types.length === 0) return null;

  const primary = types.slice(0, Math.max(1, Math.min(maxNodes, 15)));
  const ids = new Map<string, string>();
  const idFor = (name: string): string | null => {
    if (!isTypeName(name)) return null;
    const existing = ids.get(name);
    if (existing) return existing;
    if (ids.size >= maxNodes) return null;
    const id = `C${ids.size}`;
    ids.set(name, id);
    return id;
  };
  for (const type of primary) idFor(type.name);

  const body: string[] = [];
  const relations: string[] = [];
  for (const type of primary) {
    const id = ids.get(type.name)!;
    if (type.kind === 'interface' || type.kind === 'trait') body.push(`  <<interface>> ${id}`);
    for (const member of type.members ?? []) {
      const text = memberText(member);
      if (text) body.push(`  ${id} : ${text}`);
    }
    for (const parent of type.extends ?? []) {
      const pid = idFor(parent);
      if (pid && pid !== id) relations.push(`  ${pid} <|-- ${id}`);
    }
    for (const parent of type.implements ?? []) {
      const pid = idFor(parent);
      if (pid && pid !== id) relations.push(`  ${pid} <|.. ${id}`);
    }
  }

  const lines = ['classDiagram'];
  for (const [name, id] of ids) lines.push(`  class ${id}[${mermaidLabel(name)}]`);
  lines.push(...body, ...relations);
  return lines.join('\n');
}

// --- sequence -----------------------------------------------------------------

/**
 * What the model returns for a flow. It names participants and messages; it
 * never writes Mermaid. Anything that does not fit this shape is a dropped
 * diagram and a warning, never a page that fails to stage.
 */
export const sequenceSchema = z.object({
  participants: z.array(z.object({ name: z.string().min(1).max(200) })).min(2).max(40),
  messages: z
    .array(
      z.object({
        from: z.string().min(1).max(200),
        to: z.string().min(1).max(200),
        label: z.string().max(300).default(''),
        reply: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type SequenceSpec = z.infer<typeof sequenceSchema>;

const MAX_SEQUENCE_MESSAGES = 30;

export function sequenceFromJson(raw: unknown, maxParticipants: number): string | null {
  const parsed = sequenceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { participants, messages } = parsed.data;

  const ids = new Map<string, string>();
  const lines = ['sequenceDiagram'];
  for (const p of participants.slice(0, Math.max(2, maxParticipants))) {
    if (ids.has(p.name)) continue;
    const id = `P${ids.size}`;
    ids.set(p.name, id);
    lines.push(`  participant ${id} as ${mermaidText(p.name).replace(/:/g, ' ')}`);
  }

  let drawn = 0;
  for (const m of messages) {
    if (drawn >= MAX_SEQUENCE_MESSAGES) break;
    const from = ids.get(m.from);
    const to = ids.get(m.to);
    if (!from || !to) continue;
    const label = m.label ? mermaidText(m.label) : '';
    lines.push(`  ${from}${m.reply ? '-->>' : '->>'}${to}: ${label === '—' ? '' : label}`.trimEnd());
    drawn += 1;
  }
  return drawn > 0 ? lines.join('\n') : null;
}

// --- lint -------------------------------------------------------------------

const ID = '[A-Za-z][A-Za-z0-9_]*';
const QUOTED = '"[^"`<>%#;]*"';

const LINE_SHAPES: Record<string, RegExp[]> = {
  flowchart: [
    new RegExp(`^  ${ID}\\[${QUOTED}\\]$`),
    new RegExp(`^  ${ID}\\(\\[${QUOTED}\\]\\):::[a-z]+$`),
    new RegExp(`^  ${ID} (-->|-\\.->) ${ID}$`),
    /^ {2}classDef [a-z]+ [a-z0-9:#,\- ]+$/,
  ],
  classDiagram: [
    new RegExp(`^  class ${ID}\\[${QUOTED}\\]$`),
    new RegExp(`^  ${ID} : [\\p{L}\\p{N}_$]+$`, 'u'),
    new RegExp(`^  <<interface>> ${ID}$`),
    new RegExp(`^  ${ID} (<\\|--|<\\|\\.\\.) ${ID}$`),
  ],
  sequenceDiagram: [
    new RegExp(`^  participant ${ID} as [^"\`<>%#;:]+$`),
    new RegExp(`^  ${ID}(->>|-->>)${ID}:( [^\`<>%#;]*)?$`),
  ],
};

/**
 * The second check: does the builder's output have only the shapes the
 * builders emit? Header, then every line one of a few patterns, ids from our
 * own charset, nothing that reads as a directive or a link. A failure means a
 * builder bug, and the caller drops the diagram with a warning.
 */
export function lintMermaid(source: string): boolean {
  const [header, ...lines] = source.split('\n');
  const kind = header === 'flowchart LR' || header === 'flowchart TD' ? 'flowchart' : header;
  const shapes = LINE_SHAPES[kind];
  if (!shapes || lines.length === 0) return false;
  if (/%%|`|\bclick\b/i.test(source)) return false;
  return lines.every((line) => shapes.some((re) => re.test(line)));
}

/** A diagram as a page block, or null when it did not lint. */
export function mermaidBlock(source: string | null): string | null {
  if (!source || !lintMermaid(source)) return null;
  return ['```mermaid', source, '```'].join('\n');
}
