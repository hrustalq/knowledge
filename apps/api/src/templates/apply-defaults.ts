import { parseMarkdown, writeFrontmatter } from '../common/frontmatter.js';
import { normalizeRelation, readFrontmatterTags, relationKey } from '../common/relations.js';
import type { TemplateDefaults } from './templates.service.js';

/**
 * A template's defaults merged into a page that already has a body — an
 * import (issue #69). The body is never restructured: an imported document
 * says what it says, and the template contributes only what is true of every
 * page of its kind.
 *
 * Merged, never replaced: tags and relations are unions (relations on the pair
 * the graph uniques on), and any other inherited key is written only where the
 * page has none of its own.
 */
export function applyTemplateDefaults(markdown: string, defaults: TemplateDefaults): string {
  const { data } = parseMarkdown(markdown);
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(defaults.frontmatter)) {
    if (data[key] === undefined) patch[key] = value;
  }

  const tags = readFrontmatterTags(data);
  const knownTags = new Set(tags.map((tag) => tag.normalize('NFC').trim().toLowerCase()));
  const newTags = defaults.tags.filter((tag) => !knownTags.has(tag.normalize('NFC').trim().toLowerCase()));
  if (newTags.length > 0) patch.tags = [...(Array.isArray(data.tags) ? data.tags : tags), ...newTags];

  const existing = Array.isArray(data.relations) ? data.relations : [];
  const known = new Set(
    existing.map((entry) => normalizeRelation(entry)).flatMap((r) => (r ? [relationKey(r)] : [])),
  );
  const newRelations = defaults.relations
    .filter((relation) => !known.has(relationKey(relation)))
    .map((relation) => ({ type: relation.type, target: relation.target.key }));
  if (newRelations.length > 0) patch.relations = [...existing, ...newRelations];

  return Object.keys(patch).length > 0 ? writeFrontmatter(markdown, patch) : markdown;
}
