import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChatChannelBinding } from '@prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { GraphService } from '../src/graph/graph.service.js';
import type { ChatMessagesService } from '../src/chat/chat-messages.service.js';

/**
 * #406 (#339 criterion 4), against live infra: every way kept chat leaves —
 * retention, a switch-off, an unbind, `/forget` — empties Postgres **and**
 * ArcadeDB for the chunks it touches, and leaves every other binding's alone.
 *
 * Three workspaces put the retention rule on trial: one asks for 3 days, one
 * for more than the env ceiling (clamped), one asks for nothing (the ceiling).
 * Messages go in through `ChatMessagesService.keep` and are packed by an
 * in-process `ChatIndexSweeper`, then backdated in SQL to cross each cutoff.
 * The stub embeddings are enough: nothing here ranks.
 *
 * Needs `make infra-up`.
 */

const WS = {
  short: '40600000-0000-4406-8406-000000000001',
  long: '40600000-0000-4406-8406-000000000002',
  plain: '40600000-0000-4406-8406-000000000003',
} as const;
type Ws = keyof typeof WS;
const DAY = 86_400_000;
const ACTOR = '00000000-0000-0000-0000-000000000000';

/** Each binding holds one thread of two messages, packed into one chunk. */
const BINDINGS = {
  expired: 'short', // its whole window past 3 days
  half: 'short', // its older message past 3 days, its newest not
  fresh: 'short', // untouched
  longPast: 'long', // past the ceiling, inside the workspace's longer ask
  plainPast: 'plain', // past the ceiling
  plainWithin: 'plain', // a day inside it
  off: 'plain', // search switched off
  unbound: 'plain', // binding removed
  forgot: 'plain', // one author says /forget
} as const satisfies Record<string, Ws>;
type Label = keyof typeof BINDINGS;
const GONE: Label[] = ['expired', 'longPast', 'plainPast', 'off', 'unbound', 'forgot'];
const KEPT: Label[] = ['half', 'fresh', 'plainWithin'];

describe('chat search purges (e2e, #406)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let graph: GraphService;
  let store: ChatMessagesService;
  const nonce = randomUUID().slice(0, 8);
  const integrations = {} as Record<Ws, string>;
  const bindings = {} as Record<Label, ChatChannelBinding>;
  const chunks = {} as Record<Label, string>;
  let ceiling: number;

  const vectors = async () => new Set((await Promise.all(Object.values(WS).map((ws) => graph.chatChunkIds(ws)))).flat().map((v) => v.chunkId));
  const keep = (label: Label, n: number, author: string, at: Date) =>
    store.keep(bindings[label], {
      externalUserId: author,
      externalUserName: null,
      chatId: bindings[label].externalChatId,
      chatTitle: null,
      isDm: false,
      messageId: `${label}-${n}`,
      text: `${label} message ${n}`,
      mentioned: false,
      replyToBotMessageId: null,
      threadId: `root-${label}`,
      command: null,
      action: null,
      at,
    });
  /** Moves a packed window back in time: its first message and chunk start `firstDays` ago, its last `lastDays` ago. */
  async function age(label: Label, firstDays: number, lastDays = firstDays) {
    const first = new Date(Date.now() - firstDays * DAY);
    const last = new Date(Date.now() - lastDays * DAY);
    await prisma.chatChunk.updateMany({ where: { bindingId: bindings[label].id }, data: { firstAt: first, lastAt: last } });
    await prisma.chatMessage.updateMany({ where: { bindingId: bindings[label].id, externalMessageId: `${label}-0` }, data: { sentAt: first } });
    await prisma.chatMessage.updateMany({ where: { bindingId: bindings[label].id, externalMessageId: `${label}-1` }, data: { sentAt: last } });
  }

  beforeAll(async () => {
    process.env.EMBEDDINGS_PROVIDER = 'stub';
    const [{ createE2eApp }, { ChatWorkerModule }, prismaMod, graphMod, messagesMod, { ChatIndexSweeper }, { ChatIntegrationsService }] = await Promise.all([
      import('./e2e-app.js'),
      import('../src/chat/chat-worker.module.js'),
      import('../src/prisma/prisma.service.js'),
      import('../src/graph/graph.service.js'),
      import('../src/chat/chat-messages.service.js'),
      import('../src/chat/chat-index.sweeper.js'),
      import('../src/chat/chat-integrations.service.js'),
    ]);
    app = await createE2eApp([ChatWorkerModule]);
    prisma = app.get(prismaMod.PrismaService);
    graph = app.get(graphMod.GraphService);
    store = app.get(messagesMod.ChatMessagesService);
    await graph.ensureSchema(Number(process.env.EMBEDDINGS_DIM ?? 1024));
    ceiling = (await store.settings(WS.plain)).retentionDays.ceiling;

    for (const [key, id] of Object.entries(WS) as Array<[Ws, string]>) {
      await prisma.workspace.upsert({ where: { id }, update: {}, create: { id, name: `Chat purge e2e (#406) ${key}` } });
      integrations[key] = (await prisma.chatIntegration.create({ data: { workspaceId: id, kind: 'mattermost', name: `chat purge ${nonce}` } })).id;
    }
    await store.setRetention(WS.short, 3, ACTOR);
    await store.setRetention(WS.long, ceiling + 100, ACTOR);
    await store.setRetention(WS.plain, null, ACTOR);
    expect((await store.settings(WS.long)).retentionDays.applied).toBe(ceiling);

    const sent = new Date(Date.now() - 2 * 60 * 60_000);
    for (const [label, ws] of Object.entries(BINDINGS) as Array<[Label, Ws]>) {
      bindings[label] = await prisma.chatChannelBinding.create({
        data: { integrationId: integrations[ws], workspaceId: WS[ws], externalChatId: `ch-${label}-${nonce}`, title: `#${label}`, searchableAt: new Date() },
      });
      await keep(label, 0, label === 'forgot' ? `F-${nonce}` : 'U0', sent);
      await keep(label, 1, 'U1', new Date(sent.getTime() + 60_000));
    }
    await app.get(ChatIndexSweeper).sweep();
    for (const label of Object.keys(BINDINGS) as Label[]) {
      const rows = await prisma.chatChunk.findMany({ where: { bindingId: bindings[label].id }, select: { id: true } });
      expect(rows, label).toHaveLength(1);
      chunks[label] = rows[0].id;
    }
    expect([...(await vectors())].sort()).toEqual(Object.values(chunks).sort());

    // A loose message (in no chunk) past the cutoff goes on its own.
    await keep('fresh', 2, 'U2', new Date(Date.now() - 4 * DAY));

    await age('expired', 4);
    await age('half', 4, 1);
    await age('longPast', ceiling + 1);
    await age('plainPast', ceiling + 1);
    await age('plainWithin', ceiling - 1);
    await store.purgeExpired();
    await store.purgeBinding(bindings.off.id);
    expect(await app.get(ChatIntegrationsService).unbindFromChat(integrations.plain, bindings.unbound.externalChatId)).toBe(true);
    expect(await store.forget(integrations.plain, `F-${nonce}`)).toBe(1);

    // The reap itself, past its grace window. Not `sweep()`: that would also re-pack `forgot`'s detached message.
    await (app.get(ChatIndexSweeper) as unknown as { reap(now: number): Promise<void> }).reap(Date.now() + 6 * 60_000);
  }, 120_000);

  afterAll(async () => {
    if (!app) return;
    for (const [key, id] of Object.entries(integrations) as Array<[Ws, string]>) {
      await prisma.chatIntegration.delete({ where: { id } });
      await graph.deleteChatChunks(WS[key], Object.values(chunks));
    }
    await prisma.workspaceSettings.deleteMany({ where: { workspaceId: { in: Object.values(WS) } } });
    await app.close();
  });

  it('every purged chunk is gone from Postgres and from ArcadeDB', async () => {
    const ids = GONE.map((l) => chunks[l]);
    expect(await prisma.chatChunk.count({ where: { id: { in: ids } } })).toBe(0);
    const left = await vectors();
    expect(ids.filter((id) => left.has(id))).toEqual([]);
  });

  it('retention, switch-off and unbind leave no message behind', async () => {
    for (const label of ['expired', 'longPast', 'plainPast', 'off', 'unbound'] as Label[]) {
      expect(await prisma.chatMessage.count({ where: { bindingId: bindings[label].id } }), label).toBe(0);
    }
    expect(await prisma.chatChannelBinding.count({ where: { id: bindings.unbound.id } })).toBe(0);
  });

  it('/forget removes only that author: the sibling is detached, to be packed again', async () => {
    const left = await prisma.chatMessage.findMany({ where: { bindingId: bindings.forgot.id }, select: { authorId: true, chunkId: true } });
    expect(left).toEqual([{ authorId: 'U1', chunkId: null }]);
  });

  it('a workspace override shorter than the ceiling applies, and a longer one is clamped', async () => {
    expect(await prisma.chatChunk.count({ where: { id: chunks.expired } })).toBe(0);
    expect(await prisma.chatChunk.count({ where: { id: chunks.longPast } })).toBe(0);
    expect(await prisma.chatMessage.count({ where: { bindingId: bindings.fresh.id, externalMessageId: 'fresh-2' } })).toBe(0);
  });

  it('untouched windows, a window inside the ceiling and a half-expired one stay whole in both stores', async () => {
    const left = await vectors();
    for (const label of KEPT) {
      expect(await prisma.chatChunk.count({ where: { id: chunks[label] } }), label).toBe(1);
      expect(left.has(chunks[label]), label).toBe(true);
      const messages = await prisma.chatMessage.findMany({ where: { bindingId: bindings[label].id }, select: { chunkId: true } });
      expect(messages, label).toEqual([{ chunkId: chunks[label] }, { chunkId: chunks[label] }]);
    }
  });
});
