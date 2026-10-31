import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { CaptureResult } from '@knowledge/contracts';
import { createMasker, inn, luhn, snils } from '../src/chat/harvest-mask.js';
import { HarvestRefused, HarvestService, maskedTranscript, planCaptures } from '../src/chat/harvest.service.js';
import { harvestSummary } from '../src/chat/chat-answers.service.js';
import type { ChatThread } from '../src/chat/adapters/chat-adapter.types.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';

/**
 * Harvesting a chat thread into captures (#82, phase 2). What is pinned: no
 * email, phone, card or token in a thread reaches the model, a capture or a
 * reply; a glossary term the thread does not contain and an answer no
 * searched page supports are dropped here, not trusted to the prompt; each
 * capture carries the server's origin and is the asker's; and the chat reply
 * is counts only.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'alice.smith@example.com';
const PHONE = '+7 999 123-45-67';
const CARD = '4111 1111 1111 1111';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const RAW = [EMAIL, PHONE, CARD, TOKEN];

const thread: ChatThread = {
  messages: [
    { authorId: 'u-alice', text: `Our deploy bot is Hermes. Mail ${EMAIL} or call ${PHONE}.`, at: new Date('2026-10-19T10:00:00Z') },
    { authorId: 'u-bob', text: `Card ${CARD} on file, token ${TOKEN}. Ping ${EMAIL} again.`, at: new Date('2026-10-19T10:05:00Z') },
    { authorId: 'u-alice', text: 'Decided: deploys go out on Tuesdays only.', at: new Date('2026-10-19T10:09:00Z') },
  ],
  url: 'https://time.test/platform/pl/root-1',
  truncated: false,
};

describe('the masker', () => {
  it('replaces each kind with a numbered placeholder, the same value with the same one', () => {
    const mask = createMasker();
    expect(mask(`${EMAIL}, ${PHONE}, ${CARD}, ${TOKEN}`)).toBe('[EMAIL_1], [PHONE_1], [CARD_1], [SECRET_1]');
    expect(mask(`again ${EMAIL.toUpperCase()} and bob@example.org`)).toBe('again [EMAIL_1] and [EMAIL_2]');
  });

  it('leaves dates, times, versions and a number that fails Luhn alone', () => {
    const text = 'On 2026-10-19 14:30 we shipped v1.2.3; order 4111 1111 1111 1112 stays.';
    expect(createMasker()(text)).toBe(text);
    expect(luhn('4111111111111111')).toBe(true);
  });

  it('masks local phone shapes', () => {
    expect(createMasker()('8 (999) 123 45 67 or (555) 123-4567')).toBe('[PHONE_1] or [PHONE_2]');
  });

  describe('credentials said aloud (#551)', () => {
    // What gen-stt made of a synthetic meeting's spoken credentials on prod (2026-10-30).
    it('masks the value after a trigger word, keeping the words around it', () => {
      const mask = createMasker();
      expect(mask('Пароль от стейджа Twortistage 2026, запишите.')).toBe('Пароль от стейджа [SECRET_1], запишите.');
      expect(mask('API ключ СКИС проджект ABCD 1234567890XQW. Дальше ретро.')).toBe(
        'API ключ СКИС проджект [SECRET_2]. Дальше ретро.',
      );
      expect(mask('Телефон дежурного +791651234.')).toBe('Телефон дежурного [PHONE_1].');
      expect(mask('password: hunter2, then lunch')).toBe('password: [SECRET_3], then lunch');
      expect(mask('the api key is 7f3a9c21')).toBe('the api key is [SECRET_4]');
    });

    it('gives a value said twice one placeholder', () => {
      const mask = createMasker();
      expect(mask('пароль Twortistage 2026')).toBe('пароль [SECRET_1]');
      expect(mask('ещё раз: пароль Twortistage  2026')).toBe('ещё раз: пароль [SECRET_1]');
    });

    it('masks an address read aloud and a bare +number that lost the 3-3-2-2 shape', () => {
      const mask = createMasker();
      expect(mask('Почта Дмитрий.rlov sobakexple.com, пишите.')).toBe('Почта [EMAIL_1], пишите.');
      expect(mask('dmitry собака example точка ру')).toBe('[EMAIL_2]');
      expect(mask('звоните +7 916 512 34')).toBe('звоните [PHONE_1]');
    });

    it('leaves a trigger word followed by prose alone', () => {
      const text =
        'Пароль надо сменить до пятницы. Ключевой момент — ретро. Моя собака заболела. ' +
        'Phone call at 3pm. The password reset flow needs review. Ключ к успеху — сроки.';
      expect(createMasker()(text)).toBe(text);
    });
  });

  describe('RU identity numbers (#342)', () => {
    // Real-shaped values that pass their checksums.
    const INN10 = '7707083893';
    const INN12 = '500100732259';
    const SNILS = '112-233-445 95';

    it('checks INN and SNILS digits', () => {
      expect(inn(INN10)).toBe(true);
      expect(inn(INN12)).toBe(true);
      expect(inn('7707083894')).toBe(false);
      expect(inn('500100732258')).toBe(false);
      expect(inn('77070838')).toBe(false);
      expect(snils('11223344595')).toBe(true);
      expect(snils('11223344596')).toBe(false);
    });

    it('masks INN (10 and 12 digits) and SNILS in its written and bare forms, numbered by digits', () => {
      const mask = createMasker();
      expect(mask(`ИНН ${INN10}, ИНН ИП ${INN12}, СНИЛС ${SNILS}`)).toBe('ИНН [INN_1], ИНН ИП [INN_2], СНИЛС [SNILS_1]');
      expect(mask('снилс 112 233 445 95 или 11223344595')).toBe('снилс [SNILS_1] или [SNILS_1]');
    });

    it('masks a passport after a context word in any common spacing, or bare only in the printed 2-2-6 form', () => {
      const mask = createMasker();
      expect(mask('Паспорт: серия 45 09 номер 123456')).toBe('Паспорт: серия [PASSPORT_1]');
      expect(mask('паспорт 4509 123456; серия 4509 № 123456')).toBe('паспорт [PASSPORT_1]; серия [PASSPORT_1]');
      expect(mask('passport no. 4509123456')).toBe('passport no. [PASSPORT_1]');
      expect(mask('вот 12 34 567890 ок')).toBe('вот [PASSPORT_2] ок');
    });

    it('leaves order ids, dates, a bare 4+6 number and 12 digits failing the checksum alone', () => {
      const text =
        'Order #48213 (ORD-2026-0001) shipped 19.10.2026 at 14:30; ref 4509 123456; batch 123456789012, заказ №202610191234.';
      expect(createMasker()(text)).toBe(text);
    });

    it('keeps phones phones: separators never read as an identity, and a bare number failing a checksum stays a phone', () => {
      const mask = createMasker();
      expect(mask('+7 999 123-45-67, 8 (999) 123 45 67, 89991234567')).toBe('[PHONE_1], [PHONE_2], [PHONE_2]');
      // Ten digits failing the INN check: still a phone shape, never an INN.
      expect(inn('1234567890')).toBe(false);
      expect(mask('1234567890')).toBe('[PHONE_3]');
      // And a card is a card: no INN or passport inside its digits.
      expect(mask(`${CARD} / 4111111111111111`)).toBe('[CARD_1] / [CARD_1]');
    });
  });

  it('the transcript names people by order of appearance and keeps placeholders stable across messages', () => {
    const transcript = maskedTranscript(thread);
    for (const raw of RAW) expect(transcript).not.toContain(raw);
    expect(transcript).toContain('Person 1: Our deploy bot is Hermes. Mail [EMAIL_1]');
    expect(transcript).toContain('Person 2: Card [CARD_1] on file, token [SECRET_1]. Ping [EMAIL_1] again.');
    expect(transcript).not.toContain('u-alice');
  });
});

describe('planCaptures — validation, not the prompt', () => {
  const ctx = { workspaceId: WS, projectId: 'p-1', transcript: maskedTranscript(thread), pages: new Map([['P1', 'doc-1']]) };

  it('keeps grounded proposals and drops the rest, counting them', () => {
    const plan = planCaptures(
      {
        captures: [
          { kind: 'decision', title: 'Deploys go out on Tuesdays', context: 'Release cadence', decision: 'Tuesdays only' },
          { kind: 'glossary', term: 'Hermes', definition: 'The deploy bot.', aliases: ['Гермес'] },
          { kind: 'glossary', term: 'Zeus', definition: 'Not in the thread.' },
          { kind: 'answer', question: 'When do we deploy?', answer: 'Tuesdays.', pages: ['p1', 'P9'] },
          { kind: 'answer', question: 'Who owns it?', answer: 'Ops.', pages: ['P7'] },
          { kind: 'relation', documentId: 'doc-1' },
          { kind: 'gotcha', title: '', body: 'no title' },
        ],
      },
      ctx,
    );
    expect(plan.dropped).toBe(4);
    expect(plan.requests).toEqual([
      expect.objectContaining({ kind: 'decision', workspaceId: WS, projectId: 'p-1', session: { client: 'chat' } }),
      // The alias is not in the thread, so only the term survives.
      { kind: 'glossary', workspaceId: WS, projectId: 'p-1', session: { client: 'chat' }, term: 'Hermes', definition: 'The deploy bot.' },
      expect.objectContaining({ kind: 'answer', citedDocumentIds: ['doc-1'] }),
    ]);
  });

  it('nothing at all, or not json, is an empty plan', () => {
    expect(planCaptures({ captures: [] }, ctx)).toEqual({ requests: [], dropped: 0 });
    expect(planCaptures(null, ctx)).toEqual({ requests: [], dropped: 0 });
  });
});

function harness(
  opts: {
    recent?: number;
    captureResults?: Array<CaptureResult | Error>;
    agentEnabled?: boolean;
    searchFails?: boolean;
    /** The decision model's p for the thread (#530); absent = no decision route. */
    settles?: number | Error;
  } = {},
) {
  const prompts: string[] = [];
  const prisma = {
    aiUsage: { count: vi.fn(async () => opts.recent ?? 0) },
    project: { findFirst: vi.fn(async () => ({ id: 'p-first' })) },
  };
  const agents = {
    resolve: vi.fn(async () => ({ enabled: opts.agentEnabled ?? true, instructions: 'Harvest.', config: { enabled: true } })),
  };
  const client = {
    chat: vi.fn(async (_ctx: unknown, messages: Array<{ content: string }>) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return JSON.stringify({
        captures: [
          { kind: 'decision', title: 'Deploys go out on Tuesdays', context: `From ${'[EMAIL_1]'}`, decision: 'Tuesdays only' },
          { kind: 'glossary', term: 'Hermes', definition: 'The deploy bot.' },
          { kind: 'answer', question: 'When?', answer: 'Tuesdays.', pages: ['P1'] },
          { kind: 'glossary', term: 'Zeus', definition: 'Made up.' },
        ],
      });
    }),
  };
  const aiConfig = { captureSettings: vi.fn(async () => ({ enabled: { effective: true } })) };
  const aiUsage = { assertWithinBudget: vi.fn(async () => undefined) };
  const results = [...(opts.captureResults ?? [])];
  const captures = {
    capture: vi.fn(async () => {
      const next = results.shift() ?? ({ state: 'proposed' } as CaptureResult);
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const permissions = { scopeFor: vi.fn(async () => ({ workspaceId: WS })) };
  const search = {
    search: vi.fn(async () => {
      if (opts.searchFails) throw new Error('graph down');
      return { results: [{ documentId: 'doc-1', title: 'Release calendar', snippet: 'We deploy weekly.' }] };
    }),
  };
  const config = { get: (key: string) => ({ HARVEST_RATE_PER_HOUR: 10 })[key] };
  const decision = {
    routeFor: vi.fn(async () => (opts.settles === undefined ? null : { config: {}, thresholds: { harvest: 0.5 } })),
    noul: vi.fn(async () => {
      if (opts.settles instanceof Error) throw opts.settles;
      return opts.settles!;
    }),
  };
  const svc = new HarvestService(
    prisma as never,
    agents as never,
    client as never,
    aiConfig as never,
    aiUsage as never,
    captures as never,
    permissions as never,
    search as never,
    config as never,
    decision as never,
  );
  return { svc, prisma, client, captures, search, aiUsage, prompts, decision };
}

const input = { workspaceId: WS, projectId: 'p-1', platform: 'time' as const, chatTitle: 'Platform team', thread };

describe('HarvestService.harvest', () => {
  it('sends the model a masked thread, and writes each grounded proposal as the asker with the server origin', async () => {
    const h = harness({
      captureResults: [{ state: 'proposed' } as CaptureResult, { state: 'staged' } as CaptureResult, { state: 'duplicate' } as CaptureResult],
    });
    const outcome = await h.svc.harvest(input, DEV_PRINCIPAL);
    expect(outcome).toEqual({ proposed: 2, duplicates: 1, dropped: 1 });

    expect(h.prompts).toHaveLength(1);
    for (const raw of RAW) expect(h.prompts[0]).not.toContain(raw);
    expect(h.prompts[0]).toContain('P1: Release calendar');
    expect(h.client.chat).toHaveBeenCalledWith(
      expect.objectContaining({ userId: DEV_PRINCIPAL.userId, operation: 'harvest' }),
      expect.anything(),
      { json: true },
    );

    expect(h.captures.capture).toHaveBeenCalledTimes(3);
    const origin = {
      platform: 'time',
      chatTitle: 'Platform team',
      threadUrl: 'https://time.test/platform/pl/root-1',
      from: '2026-10-19T10:00:00.000Z',
      to: '2026-10-19T10:09:00.000Z',
    };
    for (const [req, principal, opts] of h.captures.capture.mock.calls as unknown as Array<[Record<string, unknown>, unknown, unknown]>) {
      expect(principal).toBe(DEV_PRINCIPAL);
      expect(opts).toEqual({ origin });
      for (const raw of RAW) expect(JSON.stringify(req)).not.toContain(raw);
    }
  });

  it('a capture the capture path refuses is dropped, not the harvest', async () => {
    const h = harness({ captureResults: [new BadRequestException('too long')] });
    expect(await h.svc.harvest(input, DEV_PRINCIPAL)).toEqual({ proposed: 2, duplicates: 0, dropped: 2 });
  });

  it('without a search, answers have nothing to cite and are dropped', async () => {
    const h = harness({ searchFails: true });
    expect(await h.svc.harvest(input, DEV_PRINCIPAL)).toEqual({ proposed: 2, duplicates: 0, dropped: 2 });
    expect(h.prompts[0]).toContain('(none)');
  });

  it('over HARVEST_RATE_PER_HOUR is refused before any model call or budget check', async () => {
    const h = harness({ recent: 10 });
    await expect(h.svc.harvest(input, DEV_PRINCIPAL)).rejects.toEqual(new HarvestRefused('chat.harvest.rateLimited'));
    expect(h.prisma.aiUsage.count).toHaveBeenCalledWith({
      where: {
        userId: DEV_PRINCIPAL.userId,
        operation: 'harvest',
        createdAt: { gt: expect.any(Date) },
        // The decision model's rows are not harvests (#530).
        NOT: { model: { startsWith: 'jev' } },
      },
    });
    expect(h.client.chat).not.toHaveBeenCalled();
    expect(h.captures.capture).not.toHaveBeenCalled();
  });

  it('a switched-off harvester is refused', async () => {
    const h = harness({ agentEnabled: false });
    await expect(h.svc.harvest(input, DEV_PRINCIPAL)).rejects.toEqual(new HarvestRefused('chat.capture.disabled'));
    expect(h.client.chat).not.toHaveBeenCalled();
  });

  it('with no decision route, nothing is asked of the decision model', async () => {
    const h = harness();
    await h.svc.harvest(input, DEV_PRINCIPAL);
    expect(h.decision.noul).not.toHaveBeenCalled();
    expect(h.client.chat).toHaveBeenCalledOnce();
  });

  it('a thread Jev scores below the threshold makes no harvester call and replies as an empty harvest (#530)', async () => {
    const h = harness({ settles: 0.2 });
    expect(await h.svc.harvest(input, DEV_PRINCIPAL)).toEqual({ proposed: 0, duplicates: 0, dropped: 0 });
    expect(h.client.chat).not.toHaveBeenCalled();
    expect(h.search.search).not.toHaveBeenCalled();
    const [call, state] = h.decision.noul.mock.calls[0] as unknown as [{ operation: string }, { thread: string }];
    expect(call.operation).toBe('harvest');
    // Masked and wrapped: the raw thread never leaves.
    for (const raw of RAW) expect(state.thread).not.toContain(raw);
    expect(state.thread).toContain('<chat tool="harvest">');
  });

  it('a thread at the threshold, or a failed question, harvests as before', async () => {
    for (const settles of [0.5, new Error('503')]) {
      const h = harness({ settles });
      expect((await h.svc.harvest(input, DEV_PRINCIPAL)).proposed).toBe(3);
      expect(h.client.chat).toHaveBeenCalledOnce();
    }
  });

  it('a DM with no project files into the workspace’s first', async () => {
    const h = harness();
    await h.svc.harvest({ ...input, projectId: null, chatTitle: null }, DEV_PRINCIPAL);
    expect(h.captures.capture.mock.calls[0]![0]).toMatchObject({ projectId: 'p-first' });
  });
});

describe('the chat reply', () => {
  it('is counts only — never a title', () => {
    const text = harvestSummary({ proposed: 3, duplicates: 1, dropped: 2 }, 199);
    expect(text).toBe('chat.harvest.proposed chat.harvest.duplicates chat.harvest.truncated');
    expect(text).not.toMatch(/Release calendar|Hermes|Tuesdays/);
    expect(harvestSummary({ proposed: 0, duplicates: 0, dropped: 4 }, null)).toBe('chat.harvest.nothing');
  });
});
