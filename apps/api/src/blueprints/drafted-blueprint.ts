import {
  BLUEPRINT_MAX_DEPTH,
  BLUEPRINT_MAX_PAGES,
  DOCUMENT_CATEGORIES,
  STYLE_RULE_SEVERITIES,
  STYLE_RULE_TEXT_MAX,
  type BlueprintNode,
  type Locale,
  type StyleRule,
} from '@knowledge/contracts';
import { titleLocale } from './derive-rules.js';

/**
 * Reading what the `scaffolder` wrote (#716): pure, so a spec pins it. Only the
 * keys a call asked for are read, every string is clipped to the schema's
 * limits, and a template ref counts only when the workspace has it — so what
 * comes back passes `parseBlueprint` instead of failing the whole draft.
 */

const RULES_MAX = 10;
const GUIDANCE_MAX = 500;
const TITLE_MAX = 200;
const PATTERN_MAX = 100;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** Text keyed by the script it is written in (see `readDraftedTree`). */
export const keyed = (text: string) => ({ [titleLocale(text)]: text });
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The styleguide a call drafted, or null when it wrote no usable rule. Severity defaults to warning. */
export function readStyleguide(raw: unknown): { description?: string; rules: StyleRule[] } | null {
  const sg = obj(raw);
  const rules: StyleRule[] = (Array.isArray(sg.rules) ? sg.rules : [])
    .map(obj)
    .filter((r) => str(r.text, STYLE_RULE_TEXT_MAX))
    .slice(0, RULES_MAX)
    .map((r, i) => ({
      id: `rule-${i + 1}`,
      text: str(r.text, STYLE_RULE_TEXT_MAX),
      severity: (STYLE_RULE_SEVERITIES as readonly unknown[]).includes(r.severity) ? (r.severity as StyleRule['severity']) : 'warning',
      enabled: true,
    }));
  const description = str(sg.description, 2_000);
  return rules.length ? { ...(description ? { description } : {}), rules } : null;
}

/**
 * A tree as the model reads it: one line per node, `n1.`-style ids it may
 * answer by, its category, collection rule and shape (template ref, else the
 * heading skeleton). Text only — the caller wraps it untrusted.
 */
export function outlineOf(tree: BlueprintNode[]): { ids: Map<string, BlueprintNode>; lines: string[] } {
  const ids = new Map<string, BlueprintNode>();
  const lines: string[] = [];
  const walk = (nodes: BlueprintNode[], depth: number) => {
    for (const node of nodes) {
      const id = `n${ids.size + 1}`;
      ids.set(id, node);
      const title = Object.values(node.title)[0] ?? '';
      const shape = node.templateRef ?? Object.values(node.body ?? {})[0]?.replace(/\n\n/g, '; ') ?? '';
      const rule = node.collection ? ` [collection${node.collection.childTitlePattern ? `: ${Object.values(node.collection.childTitlePattern)[0]}…` : ''}]` : '';
      lines.push(`${'  '.repeat(depth)}${id}. ${title}${node.category ? ` (${node.category})` : ''}${rule}${shape ? ` — ${shape}` : ''}`);
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(tree, 0);
  return { ids, lines };
}

/** Per-node guidance for the ids a call handed out; unknown ids and blanks are skipped. */
export function applyGuidance(raw: unknown, ids: Map<string, BlueprintNode>, lang: Locale): void {
  for (const [id, text] of Object.entries(obj(raw))) {
    const node = ids.get(id);
    const clipped = str(text, GUIDANCE_MAX);
    if (node && clipped) node.guidance = { [lang]: clipped };
  }
}

/**
 * A drafted page tree. Each string is keyed by the script it is written in,
 * not the language it was asked for: a model asked for Russian sometimes
 * answers in English, and English text under `ru` would read as a
 * translation that never happened. A node with no title is dropped with
 * its children; an unknown category or template ref is dropped from the node;
 * past `BLUEPRINT_MAX_DEPTH` levels or `BLUEPRINT_MAX_PAGES` pages the rest
 * is cut, since a page budget is a limit, not an error.
 */
export function readDraftedTree(raw: unknown, refs: ReadonlySet<string>): BlueprintNode[] {
  let pages = 0;
  const ref = (v: unknown) => (typeof v === 'string' && refs.has(v.trim()) ? v.trim() : undefined);
  const walk = (nodes: unknown, level: number): BlueprintNode[] => {
    if (!Array.isArray(nodes) || level > BLUEPRINT_MAX_DEPTH) return [];
    const out: BlueprintNode[] = [];
    for (const item of nodes) {
      const n = obj(item);
      const title = str(n.title, TITLE_MAX);
      // A title carrying a placeholder is a collection's pattern the model wrote out as a page: not a page.
      if (!title || title.includes('{{') || pages >= BLUEPRINT_MAX_PAGES) continue;
      pages += 1;
      const node: BlueprintNode = { title: keyed(title) };
      if ((DOCUMENT_CATEGORIES as readonly unknown[]).includes(n.category)) node.category = n.category as BlueprintNode['category'];
      const template = ref(n.template);
      if (template) node.templateRef = template;
      const guidance = str(n.guidance, GUIDANCE_MAX);
      if (guidance) node.guidance = keyed(guidance);
      if (n.collection && typeof n.collection === 'object') {
        const c = obj(n.collection);
        const childTemplate = ref(c.template);
        // Not trimmed: a pattern's trailing space ("ADR {{n:4}}: ") is the gap before the title.
        const pattern = typeof c.pattern === 'string' ? c.pattern.slice(0, PATTERN_MAX) : '';
        node.collection = {
          ...(childTemplate ? { childTemplateRef: childTemplate } : {}),
          ...(pattern.trim() ? { childTitlePattern: keyed(pattern) } : {}),
        };
      }
      const children = walk(n.children, level + 1);
      if (children.length) node.children = children;
      out.push(node);
    }
    return out;
  };
  return walk(raw, 1);
}
