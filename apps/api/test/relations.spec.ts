import { describe, expect, it } from 'vitest';
import { normalizeEntityKey, normalizeRelationType } from '@knowledge/contracts';
import { composeFrontmatter, keepFrontmatter, parseMarkdown, writeFrontmatter } from '../src/common/frontmatter.js';
import {
  dedupeRelations,
  normalizeRelation,
  readFrontmatterRelations,
  readFrontmatterTags,
  tagEntityKey,
  tagFilterKey,
} from '../src/common/relations.js';
import { extractFrontmatterFacts } from '../src/ingestion/relations.js';

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

  it('keeps the base frontmatter when an agent posts back the bare body it read', () => {
    // getContent splits the block off, and every revision tool asks for "the
    // complete markdown" — so a read-edit-write loop used to strip relations.
    const base = parseMarkdown(PAGE);
    const next = keepFrontmatter(`${base.body}\nMore text.\n`, base.data);
    const { data, body } = parseMarkdown(next);

    expect(data).toEqual(base.data);
    expect(body).toContain('More text.');
  });

  it('takes a submitted block as written, including an emptied one', () => {
    const base = parseMarkdown(PAGE).data;
    expect(parseMarkdown(keepFrontmatter('---\ntags: [x]\n---\n# T\n', base)).data).toEqual({ tags: ['x'] });
    expect(parseMarkdown(keepFrontmatter('---\n---\n# T\n', base)).data).toEqual({});
    expect(keepFrontmatter('# T\n', null)).toBe('# T\n');
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

  it('accepts the targetKey spelling agents copy from tool schemas', () => {
    // A page written as `{type, targetKey, name}` used to lose the relation at
    // ingestion without an error — the entity simply never appeared.
    expect(normalizeRelation({ type: 'RELATED_TO', targetKey: 'product:Babbler', name: 'Babbler' })).toEqual({
      type: 'RELATED_TO',
      target: { key: 'product:babbler', type: 'product', name: 'Babbler' },
    });
    expect(normalizeRelation({ type: 'RELATED_TO', targetKey: 'product:babbler' })?.target.name).toBe('babbler');
    expect(
      normalizeRelation({ type: 'DEPENDS_ON', target: 'service:a', targetKey: 'service:b' })?.target.key,
    ).toBe('service:a');
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

// ---------------------------------------------------------------------------
// Bilingual canonicalization.
//
// The corpus is ru + en. Before this, entity identity was the raw byte-exact
// key, so the same service written on a Russian page and on an English page
// produced two disconnected vertices — and every failure here was silent,
// which is why the graph read as thin rather than broken.
// ---------------------------------------------------------------------------

describe('entity key canonicalization', () => {
  it('folds case, whitespace and the colon split', () => {
    expect(normalizeEntityKey('Service: Billing')).toBe('service:billing');
    expect(normalizeEntityKey('  service:billing  ')).toBe('service:billing');
    expect(normalizeEntityKey('service:Billing Engine')).toBe('service:billing-engine');
    expect(normalizeEntityKey('Сервис: Биллинг')).toBe('сервис:биллинг');
  });

  it('keeps a bare key bare and splits only on the first colon', () => {
    expect(normalizeEntityKey('Postgres')).toBe('postgres');
    expect(normalizeEntityKey('service:eu:Billing')).toBe('service:eu:billing');
  });

  it('collapses NFD and NFC spellings of the same Cyrillic word', () => {
    // "й" composed vs. и + U+0306. Identical on screen, two rows in a unique index.
    const composed = 'сервис:мой';
    const decomposed = 'сервис:мой';
    expect(decomposed).not.toBe(composed);
    expect(normalizeEntityKey(decomposed)).toBe(normalizeEntityKey(composed));
  });
});

describe('relation type canonicalization', () => {
  it('accepts the casings people actually write', () => {
    expect(normalizeRelationType('depends_on')).toBe('DEPENDS_ON');
    expect(normalizeRelationType('Depends On')).toBe('DEPENDS_ON');
    expect(normalizeRelationType('depends-on')).toBe('DEPENDS_ON');
  });

  it('accepts the Russian spellings', () => {
    expect(normalizeRelationType('зависит_от')).toBe('DEPENDS_ON');
    expect(normalizeRelationType('Описывает')).toBe('DESCRIBES');
    expect(normalizeRelationType('реализует')).toBe('IMPLEMENTS');
  });

  it('still refuses TAGGED_WITH and nonsense', () => {
    // Tags are synthesised from `tags:`; accepting the edge type here would
    // give them two spellings that behave differently.
    expect(normalizeRelationType('TAGGED_WITH')).toBeNull();
    expect(normalizeRelationType('DROP TABLE')).toBeNull();
  });
});

describe('bilingual frontmatter', () => {
  const RU_PAGE = `---
теги:
  - Безопасность
  - безопасность
связи:
  - type: зависит_от
    target: "Сервис: Биллинг"
---

# Сервис идентификации
`;

  it('reads Russian frontmatter keys', () => {
    const { data } = parseMarkdown(RU_PAGE);
    expect(readFrontmatterRelations(data)).toEqual([
      { type: 'DEPENDS_ON', target: { key: 'сервис:биллинг', type: 'сервис', name: 'Биллинг' } },
    ]);
  });

  it('dedupes tags that differ only in case, keeping the first spelling', () => {
    const { data } = parseMarkdown(RU_PAGE);
    expect(readFrontmatterTags(data)).toEqual(['Безопасность']);
  });

  it('prefers the canonical English key when a page carries both', () => {
    expect(readFrontmatterTags({ tags: ['a'], теги: ['b'] })).toEqual(['a']);
  });

  it('lands a ru page and an en page on one entity key', () => {
    const ru = normalizeRelation({ type: 'зависит_от', target: 'Service: Billing' });
    const en = normalizeRelation({ type: 'DEPENDS_ON', target: 'service:billing' });
    expect(ru?.target.key).toBe(en?.target.key);
    expect(ru?.type).toBe(en?.type);
  });
});

describe('tag entity keys', () => {
  it('uses one spelling for synthesis and for filtering', () => {
    expect(tagEntityKey('Безопасность')).toBe('tag:безопасность');
    expect(tagFilterKey('Безопасность')).toBe('tag:безопасность');
    expect(tagFilterKey('tag:Безопасность')).toBe('tag:безопасность');
  });
});

describe('deterministic extraction', () => {
  it('synthesises canonical tag edges and reads both languages', () => {
    const facts = extractFrontmatterFacts({
      теги: ['Безопасность'],
      relations: [{ type: 'описывает', target: 'service:Billing' }],
    });
    expect(facts).toEqual([
      { type: 'DESCRIBES', target: { key: 'service:billing', type: 'service', name: 'Billing' } },
      { type: 'TAGGED_WITH', target: { key: 'tag:безопасность', type: 'tag', name: 'Безопасность' } },
    ]);
  });

  it('drops a target that folds away to punctuation', () => {
    expect(extractFrontmatterFacts({ relations: [{ type: 'DESCRIBES', target: ' : ' }] })).toEqual([]);
  });
});
