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

import { readFrontmatterRelations, readFrontmatterTags, tagEntityKey } from '../common/relations.js';

export interface ExtractedFact {
  type: string;
  target: { key: string; type: string; name: string };
}

// TAGGED_WITH is absent on purpose: a tag edge is synthesised from the `tags:`
// key below, so accepting it here would give tags two spellings. That rule now
// lives with the vocabulary itself, in @knowledge/contracts.

export function extractFrontmatterFacts(frontmatter: Record<string, unknown>): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // Both readers go through the shared normalizer, so `связи:`/`теги:` are read
  // and every key arrives canonically folded. Reading the raw keys here — which
  // is what this did — meant the write path and the parse path disagreed about
  // what a relation was spelled like.
  for (const rel of readFrontmatterRelations(frontmatter)) {
    facts.push(rel);
  }

  for (const tag of readFrontmatterTags(frontmatter)) {
    facts.push({ type: 'TAGGED_WITH', target: { key: tagEntityKey(tag), type: 'tag', name: tag } });
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
