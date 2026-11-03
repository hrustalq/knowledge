import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  BLUEPRINT_MAX_DEPTH,
  BLUEPRINT_MAX_PAGES,
  DOCUMENT_CATEGORIES,
  STYLE_RULE_ID_PATTERN,
  STYLE_RULE_SEVERITIES,
  STYLE_RULE_TEXT_MAX,
  SUPPORTED_LOCALES,
  parseTemplateRef,
  type Blueprint,
  type BlueprintNode,
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
  })
  .superRefine((b, ctx) => {
    const { pages, depth } = shape(b.tree);
    if (pages > BLUEPRINT_MAX_PAGES) ctx.addIssue({ code: 'custom', path: ['tree'], message: `more than ${BLUEPRINT_MAX_PAGES} pages` });
    if (depth > BLUEPRINT_MAX_DEPTH) ctx.addIssue({ code: 'custom', path: ['tree'], message: `deeper than ${BLUEPRINT_MAX_DEPTH} levels` });
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
