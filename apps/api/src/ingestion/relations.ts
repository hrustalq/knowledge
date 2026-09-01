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

export interface ExtractedFact {
  type: string;
  target: { key: string; type: string; name: string };
}

const RELATION_TYPES = new Set([
  'DESCRIBES',
  'DEPENDS_ON',
  'IMPLEMENTS',
  'RELATED_TO',
  'OWNED_BY',
  'SUPERSEDES',
  'CONTRADICTS',
]);

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

function normalizeRelation(rel: unknown): ExtractedFact | null {
  if (typeof rel !== 'object' || rel === null) return null;
  const { type, target } = rel as { type?: unknown; target?: unknown };
  if (typeof type !== 'string' || !RELATION_TYPES.has(type)) return null;

  if (typeof target === 'string' && target.trim()) {
    const key = target.trim();
    const entityType = key.includes(':') ? key.slice(0, key.indexOf(':')) : 'entity';
    return { type, target: { key, type: entityType, name: key.split(':').pop() ?? key } };
  }

  if (typeof target === 'object' && target !== null) {
    const t = target as { type?: unknown; key?: unknown; name?: unknown };
    if (typeof t.key !== 'string' || !t.key.trim()) return null;
    const key = t.key.trim();
    const entityType = typeof t.type === 'string' && t.type.trim() ? t.type.trim() : 'entity';
    const name =
      typeof t.name === 'string' && t.name.trim() ? t.name.trim() : (key.split(':').pop() ?? key);
    return { type, target: { key, type: entityType, name } };
  }

  return null;
}
