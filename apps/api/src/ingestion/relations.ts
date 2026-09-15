/**
 * Deterministic relation extraction from markdown frontmatter (plan.md §5:
 * "deterministic" fact class — parser-derived, confidence 1, no LLM).
 *
 * Recognized frontmatter shapes:
 *
 *   relations:
 *     - type: DEPENDS_ON
 *       target: service:identity            # "type:key" shorthand
 *     - type: DESCRIBES
 *       target: { type: service, key: service:billing, name: Billing }
 *   tags: [security, identity]
 */

import { normalizeRelation as normalizeRelationInput } from '../common/relations.js';

export interface ExtractedFact {
  type: string;
  target: { key: string; type: string; name: string };
}

// TAGGED_WITH is absent on purpose: a tag edge is synthesised from the `tags:`
// key below, so accepting it here would give tags two spellings. That rule now
// lives with the vocabulary itself, in @knowledge/contracts.

export function extractFrontmatterFacts(frontmatter: Record<string, unknown>): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  const relations = frontmatter['relations'];
  if (Array.isArray(relations)) {
    for (const rel of relations) {
      const fact = normalizeRelation(rel);
      if (fact) facts.push(fact);
    }
  }

  const tags = frontmatter['tags'];
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag !== 'string' || !tag.trim()) continue;
      const name = tag.trim();
      facts.push({ type: 'TAGGED_WITH', target: { key: `tag:${name}`, type: 'tag', name } });
    }
  }

  // De-duplicate (type, target.key) pairs.
  const seen = new Set<string>();
  return facts.filter((f) => {
    const id = `${f.type} ${f.target.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Delegates to the shared normalizer so the parse direction and the write
 * direction cannot disagree about what a relation is — the same reasoning that
 * moved the edge-type vocabulary into @knowledge/contracts.
 */
function normalizeRelation(rel: unknown): ExtractedFact | null {
  return normalizeRelationInput(rel);
}
