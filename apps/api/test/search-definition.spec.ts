import { describe, expect, it } from 'vitest';
import { SEARCH_MIN_COSINE_SHARE, SEARCH_RRF_K, TRUST_WEIGHTS, type SourceVerificationState } from '@knowledge/contracts';
import { definitionMatcher, rankPool, type SearchKnobs, type SearchPool } from '../src/search/ranking.js';

const KNOBS: SearchKnobs = { rrfK: SEARCH_RRF_K, minCosine: 0.4, minCosineShare: SEARCH_MIN_COSINE_SHARE, communityPriorWeight: 0, communityPriorFloor: 0.5, trustWeights: TRUST_WEIGHTS };

type Hit = SearchPool['vectorHits'][number];
const hit = (documentId: string, score: number, text = `about ${documentId}`, headingPath: string[] = []): Hit => ({ documentId, chunkId: `c-${documentId}`, revisionId: 'r', text, headingPath, score });
const pagesOf = (states: Record<string, SourceVerificationState>) =>
  new Map(Object.entries(states).map(([id, status]) => [id, { status, inactive: false, archived: false }]));

/**
 * #742's query, on the hits and states production returned for it on 2026-11-04.
 * The vector leg passed four chunks over its floor. The text leg ranked short
 * chunks that say "Sources" and "Watchdog" and held nothing of the glossary's.
 */
const GLOSSARY = '**Source**: A place Watchdog watches for new things: a website, a GitHub repo, an RSS feed.\n_Avoid_: Watch source.';
const reported: SearchPool = {
  query: 'what is a Source in Watchdog?',
  vectorHits: [hit('glossary', 0.689, GLOSSARY), hit('watchdog', 0.689), hit('sources', 0.6733), hit('mention', 0.622)],
  textHits: ['watchdog', 'x1', 'inoreader', 'competitors', 'mention', 'vision', 'octolens', 'f5bot', 'brand24', 'brief', 'x2', 'x3', 'x4', 'x5', 'sources'].map((id, i) => hit(id, 20 - i * 0.4)),
  fetchK: 36,
  k: 12,
  trustOn: true,
  communities: [],
  pages: pagesOf({
    glossary: 'edited',
    watchdog: 'edited',
    sources: 'edited',
    mention: 'verified',
    inoreader: 'verified',
    competitors: 'verified',
    vision: 'verified',
    octolens: 'verified',
    f5bot: 'verified',
    brand24: 'verified',
    brief: 'verified',
    x1: 'verified',
    x2: 'verified',
    x3: 'verified',
    x4: 'verified',
    x5: 'verified',
  }),
};

describe('the page defining a term (#742)', () => {
  it('reaches the top 3 for the reported query', () => {
    expect(rankPool(reported, KNOBS).slice(0, 3)).toContain('glossary');
  });

  it('is not pushed under verified pages with no vector evidence, even with no definition to find', () => {
    const ranked = rankPool({ ...reported, query: 'how are Sources described in Watchdog?' }, KNOBS);
    expect(ranked.indexOf('glossary')).toBeLessThan(ranked.indexOf('inoreader'));
    expect(ranked.indexOf('glossary')).toBeLessThan(ranked.indexOf('brief'));
  });

  it('keeps the boost for a verified page in a near-tie', () => {
    const pool: SearchPool = { ...reported, query: 'q', textHits: [], vectorHits: [hit('watchdog', 0.7), hit('mention', 0.68)] };
    expect(rankPool(pool, KNOBS)).toEqual(['mention', 'watchdog']);
  });

  it('withholds the boost from a clearly weaker match', () => {
    const pool: SearchPool = { ...reported, query: 'q', textHits: [], vectorHits: [hit('watchdog', 0.7), hit('mention', 0.64)] };
    expect(rankPool(pool, KNOBS)).toEqual(['watchdog', 'mention']);
  });

  it('still demotes a weak match on a page marked down', () => {
    const pool: SearchPool = { ...reported, query: 'q', textHits: [], vectorHits: [hit('a', 0.7), hit('b', 0.69)], pages: pagesOf({ a: 'outdated', b: 'unverified' }) };
    expect(rankPool(pool, KNOBS)).toEqual(['b', 'a']);
  });

  it('boosts verified pages as before when there is no vector leg to compare with', () => {
    const pool: SearchPool = { ...reported, query: 'q', vectorHits: [], textHits: [hit('watchdog', 10), hit('mention', 9.5)] };
    expect(rankPool(pool, KNOBS)).toEqual(['mention', 'watchdog']);
  });
});

describe('definitionMatcher', () => {
  const defines = (query: string, text: string, headingPath: string[] = []) => definitionMatcher(query)?.({ text, headingPath }) ?? null;

  it('answers only a question that asks what something is', () => {
    expect(definitionMatcher('how do Sources get ingested?')).toBeNull();
    expect(definitionMatcher('Source')).toBeNull();
    expect(definitionMatcher('what is a Source?')).not.toBeNull();
    expect(definitionMatcher('что такое источник?')).not.toBeNull();
  });

  it.each([
    ['what is a Source in Watchdog?', '**Source**: A place Watchdog watches.'],
    ['What are Sources?', '- **Source**: A place.'],
    ["what's the Feed", 'Intro.\n\n**Feed:** where Items land.'],
    ['define Item', '__Item__ — one thing that came in.'],
    ['what does Severity mean?', 'Severity — how bad it is.'],
    ['что такое источник?', '**Источник** — место, за которым следит Watchdog.'],
    ['what is a Digest Action?', '**Digest Action**: sends a digest.'],
  ])('%s finds its definition', (query, text) => {
    expect(defines(query, text)).toBe(true);
  });

  it('takes a section headed with the term as defining it', () => {
    expect(defines('what is a Source?', 'A place Watchdog watches.', ['Domain glossary', 'Source'])).toBe(true);
    expect(defines('what is a Source?', 'A place Watchdog watches.', ['Source', 'History'])).toBe(false);
  });

  it.each([
    ['a mention in passing', 'Both watch **Sources** for mentions.'],
    ['a citation line', 'Source: https://example.com/page'],
    ['a longer term starting with it', '**Source code**: what it is built from.'],
    ['a bold label that is another word', '- **Overlap:** Both watch Sources.'],
  ])('is not fooled by %s', (_name, text) => {
    expect(defines('what is a Source?', text)).toBe(false);
  });

  it('treats a query full of regex syntax as text', () => {
    expect(defines('what is C++ (the language)?', '**C++**: a language.')).toBe(true);
    expect(defines('what is .*', '**Source**: a place.')).toBe(false);
  });
});
