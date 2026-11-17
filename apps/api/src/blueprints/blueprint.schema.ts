import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { validateGraph } from '@knowledge/workflow';
import {
  BLUEPRINT_LEVEL_GUIDANCE_MAX,
  BLUEPRINT_MAX_AGENTS,
  BLUEPRINT_MAX_DEPTH,
  BLUEPRINT_MAX_LEVELS,
  BLUEPRINT_MAX_PAGES,
  BLUEPRINT_MAX_WORKFLOWS,
  BUILT_IN_AGENT_KEYS,
  DOCUMENT_CATEGORIES,
  LEARNING_TARGETS,
  MODEL_TIERS,
  STYLE_RULE_ID_PATTERN,
  STYLE_RULE_SEVERITIES,
  STYLE_RULE_TEXT_MAX,
  SUPPORTED_LOCALES,
  parseTemplateRef,
  type Blueprint,
  type BlueprintNode,
  type WorkflowGraph,
} from '@knowledge/contracts';
import { t } from '../i18n/t.js';

/**
 * The one parse of a blueprint (#716): the wizard's edited tree, a built-in, and
 * later a derived or generated one all pass here before anything is written.
 * Lives API-side because `@knowledge/contracts` carries no runtime dependency.
 */

const loose = (max: number) => z.partialRecord(z.enum(SUPPORTED_LOCALES), z.string().max(max));
const text = (max: number) => loose(max).refine((v) => Object.values(v).some((s) => s?.trim()), 'needs text in at least one language');

const templateRef = z.string().max(200).refine((ref) => parseTemplateRef(ref) !== null, 'not a template ref');

const node: z.ZodType<BlueprintNode> = z.lazy(() =>
  z.strictObject({
    title: text(200),
    category: z.enum(DOCUMENT_CATEGORIES).optional(),
    templateRef: templateRef.optional(),
    body: loose(20_000).optional(),
    guidance: loose(2_000).optional(),
    collection: z
      .strictObject({
        childTemplateRef: templateRef.optional(),
        childTitlePattern: loose(100).optional(),
      })
      .optional(),
    children: z.array(node).optional(),
  }),
);

const styleRule = z.strictObject({
  id: z.string().regex(STYLE_RULE_ID_PATTERN),
  text: z.string().trim().min(1).max(STYLE_RULE_TEXT_MAX),
  severity: z.enum(STYLE_RULE_SEVERITIES),
  enabled: z.boolean(),
  example: z.strictObject({ bad: z.string().max(STYLE_RULE_TEXT_MAX), good: z.string().max(STYLE_RULE_TEXT_MAX) }).optional(),
});

/** A methodology's own keys: short enough to namespace per blueprint and still fit `ai_agents.key`. */
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lower-case letters, digits and dashes, at most 40');

const level = z.strictObject({
  key: slug,
  name: text(120),
  description: loose(2_000).optional(),
  templateRefs: z.array(templateRef).max(20),
  agentKey: z.string().max(60).optional(),
  guidance: loose(BLUEPRINT_LEVEL_GUIDANCE_MAX).optional(),
});

/**
 * Only the envelope the compiler reads unguarded; every rule about steps is
 * `validateGraph`'s, the one check a workflow definition passes before a write.
 */
const graph = (z
  .strictObject({
    steps: z.array(z.looseObject({ id: z.string(), kind: z.string(), next: z.array(z.string()) })).max(50),
    layout: z.record(z.string(), z.strictObject({ x: z.number(), y: z.number() })).optional(),
  })
  .superRefine((g, ctx) => {
    for (const issue of validateGraph(g as unknown as WorkflowGraph)) {
      if (issue.severity === 'error') ctx.addIssue({ code: 'custom', message: issue.message });
    }
  }) as unknown as z.ZodType<WorkflowGraph>);

const workflow = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).optional(),
  graph,
  trigger: z
    .strictObject({
      manual: z.boolean(),
      autoStart: z.boolean(),
      events: z.array(z.string().max(100)).max(20),
      categories: z.array(z.enum(DOCUMENT_CATEGORIES)),
    })
    .optional(),
});

const agent = z.strictObject({
  // A built-in's key (or `mcp`) would make the agent registry ambiguous: the custom-agent rule.
  key: slug.refine((k) => !(LEARNING_TARGETS as readonly string[]).includes(k), 'a built-in agent key'),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  instructions: z.string().trim().min(1).max(16_000),
  tools: z.array(z.string().max(100)).max(50).optional(),
  minTier: z.enum(MODEL_TIERS).optional(),
});

const unique = (values: string[]) => values.filter((v, i) => values.indexOf(v) !== i);

function shape(tree: BlueprintNode[]): { pages: number; depth: number } {
  let pages = 0;
  let depth = 0;
  const walk = (nodes: BlueprintNode[], level: number) => {
    for (const n of nodes) {
      pages += 1;
      depth = Math.max(depth, level);
      walk(n.children ?? [], level + 1);
    }
  };
  walk(tree, 1);
  return { pages, depth };
}

export const blueprintSchema: z.ZodType<Blueprint> = z
  .strictObject({
    name: text(120),
    description: loose(2_000).optional(),
    icon: z.string().max(16).optional(),
    tree: z.array(node),
    conventions: z
      .strictObject({
        styleguide: z
          .strictObject({ description: z.string().max(2_000).optional(), rules: z.array(styleRule).max(200) })
          .optional(),
        templates: z
          .array(
            z.strictObject({
              name: z.string().trim().min(1).max(120),
              source: z.string().min(1).max(100_000),
              description: z.string().max(2_000).optional(),
              icon: z.string().max(16).optional(),
            }),
          )
          .max(50)
          .optional(),
        glossary: z
          .array(
            z.strictObject({
              term: z.string().trim().min(1).max(200),
              definition: z.string().trim().min(1).max(4_000),
              aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
            }),
          )
          .max(500)
          .optional(),
      })
      .optional(),
    levels: z.array(level).max(BLUEPRINT_MAX_LEVELS).optional(),
    workflows: z.array(workflow).max(BLUEPRINT_MAX_WORKFLOWS).optional(),
    agents: z.array(agent).max(BLUEPRINT_MAX_AGENTS).optional(),
  })
  .superRefine((b, ctx) => {
    const { pages, depth } = shape(b.tree);
    if (pages > BLUEPRINT_MAX_PAGES) ctx.addIssue({ code: 'custom', path: ['tree'], message: `more than ${BLUEPRINT_MAX_PAGES} pages` });
    if (depth > BLUEPRINT_MAX_DEPTH) ctx.addIssue({ code: 'custom', path: ['tree'], message: `deeper than ${BLUEPRINT_MAX_DEPTH} levels` });

    const levels = b.levels ?? [];
    for (const key of unique(levels.map((l) => l.key))) ctx.addIssue({ code: 'custom', path: ['levels'], message: `duplicate level key "${key}"` });
    for (const name of unique((b.workflows ?? []).map((w) => w.name))) ctx.addIssue({ code: 'custom', path: ['workflows'], message: `duplicate workflow "${name}"` });
    const own = (b.agents ?? []).map((a) => a.key);
    for (const key of unique(own)) ctx.addIssue({ code: 'custom', path: ['agents'], message: `duplicate agent key "${key}"` });
    const known = new Set<string>([...BUILT_IN_AGENT_KEYS, ...own]);
    levels.forEach((l, i) => {
      if (l.agentKey !== undefined && !known.has(l.agentKey)) {
        ctx.addIssue({ code: 'custom', path: ['levels', i, 'agentKey'], message: `unknown agent "${l.agentKey}"` });
      }
    });
  });

/** The blueprint, or a 400 naming the first few problems by path. */
export function parseBlueprint(raw: unknown): Blueprint {
  const result = blueprintSchema.safeParse(raw);
  if (result.success) return result.data;
  const detail = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  throw new BadRequestException({ statusCode: 400, message: t('error.blueprint.invalid', { detail }), issues: result.error.issues.slice(0, 20) });
}
