import { consolidationDay, consolidationPrompt, globMatch, observationSettings, readConsolidation, refinement, scopeMatches } from '../src/memory/memory-observations.js';
import { preferObservations } from '../src/memory/memory-recall.service.js';
import { MemoryConsolidationService } from '../src/memory/memory-consolidation.service.js';
import { MemoryConsolidationSweeper } from '../src/memory/memory-consolidation.sweeper.js';
import { withLocaleDirective } from '../src/assistant/assistant.client.js';

/**
 * #993: the consolidator's answer is a claim, and the reader keeps only what
 * the facts it was shown prove. A quote must be verbatim in the fact it
 * cites; an observation left with no evidence is not written.
 */
describe('readConsolidation', () => {
  const facts = [{ text: 'Alice prefers tea over coffee.' }, { text: 'Alice drinks green tea every morning.' }, { text: 'Bob joined the billing team in May.' }];
  const observations = [{ text: 'Alice likes tea.' }];

  it('keeps a new observation whose quotes are verbatim in their facts', () => {
    const out = readConsolidation(
      { observations: [{ observation: null, text: 'Alice drinks tea, green in the morning.', evidence: [{ fact: 'F1', quote: 'prefers tea over coffee' }, { fact: 'F2', quote: 'green tea every morning' }] }] },
      facts,
      observations,
    );
    expect(out).toEqual([{ target: null, text: 'Alice drinks tea, green in the morning.', evidence: [{ fact: 0, quote: 'prefers tea over coffee' }, { fact: 1, quote: 'green tea every morning' }] }]);
  });

  it('drops a quote that is not verbatim, and an entry left with no evidence', () => {
    const out = readConsolidation(
      {
        observations: [
          // Paraphrased: "prefers tea to coffee" is not in F1.
          { observation: null, text: 'Alice prefers tea.', evidence: [{ fact: 'F1', quote: 'prefers tea to coffee' }] },
          // One good quote survives beside a bad one.
          { observation: 'O1', evidence: [{ fact: 'F2', quote: 'Green tea' }, { fact: 'F2', quote: 'green tea' }] },
        ],
      },
      facts,
      observations,
    );
    expect(out).toEqual([{ target: 0, text: null, evidence: [{ fact: 1, quote: 'green tea' }] }]);
  });

  it('drops labels it never handed out, a new observation with no text, and a second refine of one observation', () => {
    const ev = [{ fact: 'F3', quote: 'joined the billing team' }];
    const out = readConsolidation(
      {
        observations: [
          { observation: 'O2', text: 'x', evidence: ev },
          { observation: null, evidence: ev },
          { observation: null, text: 'Bob is on billing.', evidence: [{ fact: 'F9', quote: 'Bob' }] },
          { observation: 'O1', text: 'Alice likes tea; Bob is on billing.', evidence: ev },
          { observation: 'O1', text: 'Second refine.', evidence: ev },
        ],
      },
      facts,
      observations,
    );
    expect(out).toEqual([{ target: 0, text: 'Alice likes tea; Bob is on billing.', evidence: [{ fact: 2, quote: 'joined the billing team' }] }]);
  });

  it('reads nothing from an answer of the wrong shape', () => {
    expect(readConsolidation(null, facts, observations)).toEqual([]);
    expect(readConsolidation({ observations: 'all of them' }, facts, observations)).toEqual([]);
    expect(readConsolidation({ observations: [null, 7, { evidence: 'F1' }] }, facts, observations)).toEqual([]);
  });

  it('wraps the facts and the observations it shows the model as untrusted', () => {
    const prompt = consolidationPrompt(facts, observations, 'Remember preferences.');
    expect(prompt).toContain('What this memory bank is for: Remember preferences.');
    expect(prompt).toMatch(/<memories tool="consolidate">\n[^\n]*\nF1: Alice prefers tea over coffee\.\nF2:/);
    expect(prompt).toMatch(/<memories tool="consolidate">\n[^\n]*\nO1: Alice likes tea\./);
    expect(consolidationPrompt(facts, [], '')).toContain('Existing observations:\n(none yet)');
  });
});

describe('refinement', () => {
  it('keeps the text it replaces for the history row', () => {
    expect(refinement('Alice likes tea.', { text: 'Alice switched from tea to coffee in June.' })).toEqual({ text: 'Alice switched from tea to coffee in June.', previous: 'Alice likes tea.' });
  });

  it('writes no history when only evidence is added or the wording is unchanged', () => {
    expect(refinement('Alice likes tea.', { text: null })).toEqual({ text: 'Alice likes tea.', previous: null });
    expect(refinement('Alice likes tea.', { text: 'Alice likes tea.' })).toEqual({ text: 'Alice likes tea.', previous: null });
  });
});

describe('consolidationDay', () => {
  it('is the UTC day, so the cap resets at midnight UTC', () => {
    expect(consolidationDay(Date.parse('2026-11-12T23:59:59Z'))).toBe('2026-11-12');
    expect(consolidationDay(Date.parse('2026-11-13T00:00:00Z'))).toBe('2026-11-13');
  });
});

describe('preferObservations', () => {
  const r = (id: string, factType: string, evidence: string[] = [], text = 'x'.repeat(40)) => ({ text, row: { id, factType, evidence: evidence.map((factId) => ({ factId })) } });

  it('drops the facts a kept observation stands on and backfills the freed room', () => {
    // 10 tokens each; a budget of 30 keeps three.
    const rows = [r('f1', 'world'), r('o1', 'observation', ['f1', 'f2']), r('f2', 'world'), r('f3', 'world'), r('f4', 'world')];
    expect(preferObservations(rows, 30).map((x) => x.row.id)).toEqual(['o1', 'f3', 'f4']);
  });

  it('settles when an observation backfilled in covers more facts', () => {
    const rows = [r('f1', 'world'), r('o1', 'observation', ['f1']), r('f2', 'world'), r('o2', 'observation', ['f2']), r('f3', 'world')];
    expect(preferObservations(rows, 30).map((x) => x.row.id)).toEqual(['o1', 'o2', 'f3']);
  });

  it('changes nothing when no observation is kept', () => {
    const rows = [r('f1', 'world'), r('f2', 'world'), r('o1', 'observation', ['f1'])];
    expect(preferObservations(rows, 20).map((x) => x.row.id)).toEqual(['f1', 'f2']);
  });
});

describe('consolidation strategies (#1157)', () => {
  const bank = {
    mission: 'Bank mission', observationsMission: 'Observe decisions', maxObservationsPerScope: 50,
    consolidationSourceFactsMaxTokens: 1000, consolidationSourceFactsMaxTokensPerObservation: 100,
    consolidationStrategies: [
      { scopes: [{ tags: ['company:acme'] }], max_observations_per_scope: 5 },
      { scopes: [{ tags: ['company:*'] }], observations_mission: 'General trends only', consolidation_source_facts_max_tokens: 20 },
      { scopes: [{ tags: ['*'] }] },
    ],
  };

  it('uses the first matching non-empty strategy whole, inheriting only its unset fields', () => {
    expect(observationSettings(bank, ['company:acme'])).toEqual({ mission: 'Observe decisions', maxObservations: 5, sourceFactsMaxTokens: 1000, sourceFactsMaxTokensPerObservation: 100 });
    expect(observationSettings(bank, ['company:other'])).toEqual({ mission: 'General trends only', maxObservations: 50, sourceFactsMaxTokens: 20, sourceFactsMaxTokensPerObservation: 100 });
    expect(observationSettings(bank, [])).toMatchObject({ mission: 'Observe decisions', maxObservations: 50 });
  });

  it('matches all and exact alternatives without claiming the global scope', () => {
    expect(scopeMatches(['company:a', 'team:b'], { tags: ['company:*'] })).toBe(true);
    expect(scopeMatches(['company:a', 'team:b'], { tags: ['company:*'], tags_match: 'exact' })).toBe(false);
    expect(scopeMatches(['company:a'], { tags: ['company:*'], tags_match: 'exact' })).toBe(true);
    expect(scopeMatches([], { tags: ['*'] })).toBe(false);
  });

  it('pairs exact patterns one to one: two patterns may not share a tag', () => {
    expect(scopeMatches(['user:a', 'x'], { tags: ['user:*', 'user:*'], tags_match: 'exact' })).toBe(false);
    expect(scopeMatches(['user:a', 'user:b'], { tags: ['user:*', 'user:*'], tags_match: 'exact' })).toBe(true);
    // a* can only take ab, so * must move off it to ac.
    expect(scopeMatches(['ab', 'ac'], { tags: ['*', 'ab'], tags_match: 'exact' })).toBe(true);
    expect(scopeMatches(['a1', 'b', 'c'], { tags: ['a*', 'a*', '*'], tags_match: 'exact' })).toBe(false);
  });
});

describe('globMatch', () => {
  it('anchors both ends, is case-sensitive, and treats only * as special', () => {
    expect(globMatch('company:*', 'company:acme')).toBe(true);
    expect(globMatch('company:*', 'Company:acme')).toBe(false);
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('a*b*c', 'abc')).toBe(true);
    expect(globMatch('a*b*c', 'acb')).toBe(false);
    expect(globMatch('ab*ba', 'aba')).toBe(false);
    expect(globMatch('*.x', 'a.x')).toBe(true);
    expect(globMatch('*.x', 'abx')).toBe(false);
    expect(globMatch('a?c', 'abc')).toBe(false);
    expect(globMatch('user:a', 'user:a')).toBe(true);
    expect(globMatch('*mid*', 'xxmidyy')).toBe(true);
    expect(globMatch('**', 'anything')).toBe(true);
  });

  it('answers a pathological pattern in milliseconds', () => {
    const started = Date.now();
    expect(globMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(100))).toBe(false);
    expect(globMatch('*a*a*a*a*a*a*a*a*b', `${'a'.repeat(100_000)}b`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('memory content keeps its own language (#1022)', () => {
  it('a consolidation pass sends no reply-language directive', async () => {
    const chatWithUsage = vi.fn(async () => ({ content: '{"observations": []}', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimated: false } }));
    const self = {
      candidates: async () => [],
      usage: { assertWithinBudget: async () => undefined },
      takeCall: async () => true,
      client: { chatWithUsage },
      write: vi.fn(async () => ({ created: 0, refined: 0 })),
    };
    const batch = (MemoryConsolidationService.prototype as unknown as { batch: (...a: unknown[]) => Promise<unknown> }).batch;
    await batch.call(self, { id: 'b', workspaceId: 'ws', mission: '' }, { scopeId: 'scope-1', tags: [], claimedAt: new Date() }, [{ text: 'Алиса руководит биллингом.', tags: [] }], { config: {}, instructions: 'tidy' }, null, Date.now(), { mission: '', maxObservations: -1, sourceFactsMaxTokens: -1, sourceFactsMaxTokensPerObservation: -1 });
    const [[ctx]] = chatWithUsage.mock.calls as unknown as [[{ locale: string; operation: string }]];
    expect(ctx).toMatchObject({ operation: 'memory-consolidate', locale: 'source' });
  });

  it("'source' leaves the messages as written; a locale still appends the directive", () => {
    const messages = [{ role: 'system' as const, content: 'tidy' }, { role: 'user' as const, content: 'F1' }];
    expect(withLocaleDirective(messages, 'source')).toBe(messages);
    const ru = withLocaleDirective(messages, 'ru');
    expect(ru[0]!.content).toContain('tidy');
    expect(ru[0]!.content).not.toBe('tidy');
    expect(messages[0]!.content).toBe('tidy');
  });
});

describe('MemoryConsolidationService.write guards its claim (#1157)', () => {
  const settings = { mission: '', maxObservations: -1, sourceFactsMaxTokens: -1, sourceFactsMaxTokensPerObservation: -1 };
  const claimedAt = new Date('2026-11-16T10:00:00.000Z');
  const fact = (id: string, text: string) => ({ id, text, entities: [], occurredStart: null, occurredEnd: null, mentionedAt: null });
  const facts = [fact('f1', 'Alice owns billing.'), fact('f2', 'Bob owns search.')];
  const entries = [{ target: null, text: 'Alice owns billing.', evidence: [{ fact: 0, quote: 'Alice owns billing' }] }];

  function harness(aliveIds: string[]) {
    const prisma = {
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => aliveIds.map((unit_id) => ({ unit_id }))),
      memoryUnit: { count: vi.fn(async () => 0), create: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn() },
      memoryObservationEvidence: { createMany: vi.fn(async () => ({ count: 1 })) },
      memoryUnitEntity: { createMany: vi.fn(async () => ({ count: 0 })) },
      memoryObservationHistory: { create: vi.fn() },
      memoryObservationScopeMember: { updateMany: vi.fn(async () => ({ count: 2 })) },
    };
    const graph = { upsertMemoryUnits: vi.fn(async () => undefined), deleteMemoryUnits: vi.fn(async () => undefined) };
    const self = { prisma, graph, embeddings: { embedBatch: async (texts: string[]) => texts.map(() => [0]) }, logger: { warn: vi.fn() } };
    const write = (MemoryConsolidationService.prototype as unknown as { write: (...a: unknown[]) => Promise<unknown> }).write;
    const run = () => write.call(self, { id: 'b', workspaceId: 'ws' }, { scopeId: 'scope-1', tags: [], claimedAt }, facts, [], entries, claimedAt.getTime(), settings);
    return { prisma, graph, run };
  }

  it('writes nothing, and drops the new vector, when a fact is no longer claimed by this run', async () => {
    // f2 was retaken by a second worker, reset by invalidateFacts, or left the scope: the model saw it, so nothing of the answer is kept.
    const h = harness(['f1']);
    await expect(h.run()).resolves.toBeNull();
    expect(h.prisma.memoryUnit.create).not.toHaveBeenCalled();
    expect(h.prisma.memoryObservationScopeMember.updateMany).not.toHaveBeenCalled();
    expect(h.graph.deleteMemoryUnits).toHaveBeenCalledOnce();
    const [sql, ...values] = h.prisma.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(sql.join('?')).toMatch(/consolidated_at IS NULL AND claimed_at = \?\s+FOR UPDATE/);
    expect(values).toContain(claimedAt);
  });

  it('marks the batch read only under the same claim it holds', async () => {
    const h = harness(['f1', 'f2']);
    await expect(h.run()).resolves.toEqual({ created: 1, refined: 0 });
    expect(h.prisma.memoryObservationScopeMember.updateMany).toHaveBeenCalledWith({
      where: { scopeId: 'scope-1', unitId: { in: ['f1', 'f2'] }, consolidatedAt: null, claimedAt },
      data: { consolidatedAt: claimedAt, claimedAt: null },
    });
  });
});

describe('rows an older image wrote are repaired into scopes (#1157)', () => {
  it('runs four idempotent statements that only match legacy rows', async () => {
    const $executeRaw = vi.fn(async () => 1);
    const repair = (MemoryConsolidationService.prototype as unknown as { repairLegacyRows: () => Promise<number> }).repairLegacyRows;
    await expect(repair.call({ prisma: { $executeRaw } })).resolves.toBe(4);
    const sql = ($executeRaw.mock.calls as unknown as Array<[{ strings: string[] } | TemplateStringsArray]>).map(([q]) => (Array.isArray(q) ? q.join('?') : JSON.stringify(q)));
    expect(sql[0]).toMatch(/INSERT INTO memory_observation_scopes[\s\S]*ON CONFLICT DO NOTHING/);
    expect(sql[1]).toMatch(/INSERT INTO memory_observation_scope_members[\s\S]*ON CONFLICT DO NOTHING/);
    expect(sql[2]).toMatch(/SET observation_scope_id = s\.id[\s\S]*observation_scope_id IS NULL/);
    expect(sql[3]).toMatch(/m\.consolidated_at IS NULL AND u\.consolidated_at IS NOT NULL/);
    // A fact is legacy only with no membership and no retain-time scopes: this image's zero-scope facts carry observation_scopes.
    const legacy = ($executeRaw.mock.calls[1] as unknown as [TemplateStringsArray, ...Array<{ strings?: string[] }>]).slice(1).map((v) => v.strings?.join('?') ?? '').join(' ');
    expect(legacy).toMatch(/observation_scopes IS NULL[\s\S]*NOT EXISTS \(SELECT 1 FROM memory_observation_scope_members m WHERE m\.unit_id = u\.id\)/);
  });

  it('the sweeper repairs on its first tick and then hourly', async () => {
    const consolidation = { repairLegacyRows: vi.fn(async () => 0), pass: vi.fn() };
    const prisma = { $queryRaw: vi.fn(async () => []) };
    const features = { unavailable: () => [] };
    const sweeper = new MemoryConsolidationSweeper(prisma as never, features as never, consolidation as never);
    const t0 = Date.parse('2026-11-16T10:00:00Z');
    await sweeper.sweep(t0);
    await sweeper.sweep(t0 + 60_000);
    expect(consolidation.repairLegacyRows).toHaveBeenCalledOnce();
    await sweeper.sweep(t0 + 60 * 60_000);
    expect(consolidation.repairLegacyRows).toHaveBeenCalledTimes(2);
  });
});
