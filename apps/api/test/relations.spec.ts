import { describe, expect, it } from 'vitest';
import { composeFrontmatter, parseMarkdown, writeFrontmatter } from '../src/common/frontmatter.js';
import {
  dedupeRelations,
  normalizeRelation,
  readFrontmatterRelations,
  readFrontmatterTags,
} from '../src/common/relations.js';

const PAGE = `---
source: https://git.example.com/a/b/identity.md
glossary: false
tags:
  - security
relations:
  - type: DEPENDS_ON
    target: service:postgres
---

# Identity service

Body text.
`;

describe('frontmatter round trip', () => {
  it('preserves keys the caller did not name', () => {
    // The defect this whole helper exists for: the web editor rebuilt the block
    // from `relations` and `tags` alone, so `source` and `glossary` — written by
    // every connector adapter, and read by DocumentCanvas — were destroyed on
    // every save.
    const next = writeFrontmatter(PAGE, { tags: ['security', 'platform'] });
    const { data, body } = parseMarkdown(next);

    expect(data.source).toBe('https://git.example.com/a/b/identity.md');
    expect(data.glossary).toBe(false);
    expect(data.tags).toEqual(['security', 'platform']);
    expect(body).toContain('# Identity service');
  });

  it('merges into an existing block rather than giving up on it', () => {
    // workflow-materializer used to `return draft.markdown` whenever the body
    // already began with `---`, silently dropping everything the step produced.
    const next = writeFrontmatter(PAGE, { category: 'architecture' });
    const { data } = parseMarkdown(next);

    expect(data.category).toBe('architecture');
    expect(data.source).toBeDefined();
    expect(readFrontmatterRelations(data)).toHaveLength(1);
  });

  it('removes a key set to undefined, and drops the block when nothing is left', () => {
    const stripped = writeFrontmatter(PAGE, {
      source: undefined,
      glossary: undefined,
      tags: undefined,
      relations: undefined,
    });
    expect(parseMarkdown(stripped).data).toEqual({});
    expect(stripped.startsWith('---')).toBe(false);
  });

  it('composes a body with no frontmatter as the bare body', () => {
    expect(composeFrontmatter('# Title\n', {})).toBe('# Title\n');
  });
});

describe('relation normalization', () => {
  it('accepts both target spellings the frontmatter contract allows', () => {
    expect(normalizeRelation({ type: 'DEPENDS_ON', target: 'service:billing' })).toEqual({
      type: 'DEPENDS_ON',
      target: { key: 'service:billing', type: 'service', name: 'billing' },
    });
    expect(
      normalizeRelation({ type: 'DESCRIBES', target: { type: 'service', key: 'service:identity', name: 'Identity' } }),
    ).toEqual({ type: 'DESCRIBES', target: { key: 'service:identity', type: 'service', name: 'Identity' } });
  });

  it('refuses TAGGED_WITH and anything outside the allowlist', () => {
    // TAGGED_WITH is synthesized from `tags:`; accepting it as a relation would
    // give tags two spellings that behave differently.
    expect(normalizeRelation({ type: 'TAGGED_WITH', target: 'tag:security' })).toBeNull();
    expect(normalizeRelation({ type: 'DROP TABLE', target: 'x:y' })).toBeNull();
    expect(normalizeRelation({ type: 'DEPENDS_ON', target: '' })).toBeNull();
  });

  it('de-duplicates on (type, target key)', () => {
    const rels = dedupeRelations([
      { type: 'DEPENDS_ON', target: { key: 'service:pg', type: 'service', name: 'pg' } },
      { type: 'DEPENDS_ON', target: { key: 'service:pg', type: 'service', name: 'Postgres' } },
      { type: 'DESCRIBES', target: { key: 'service:pg', type: 'service', name: 'pg' } },
    ]);
    expect(rels).toHaveLength(2);
  });

  it('reads relations and tags out of a page, skipping malformed entries', () => {
    const { data } = parseMarkdown(PAGE);
    expect(readFrontmatterRelations(data)).toEqual([
      { type: 'DEPENDS_ON', target: { key: 'service:postgres', type: 'service', name: 'postgres' } },
    ]);
    expect(readFrontmatterTags(data)).toEqual(['security']);
    expect(readFrontmatterRelations({ relations: 'nonsense' })).toEqual([]);
    expect(readFrontmatterTags(null)).toEqual([]);
  });
});
