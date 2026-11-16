import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { GraphService } from '../src/graph/graph.service.js';

/**
 * #1167 acceptance, end to end against live infra: the runtime memory loop
 * (recall → answer → retain) for an assistant turn and for a background run,
 * on a stub OpenAI-compatible model served from this file.
 *
 * Forces `AUTH_MODE=api-key` with its own editor (never a platform admin),
 * `MEMORY_ENABLED`, stub embeddings and no extraction model, so retain stores
 * the turn verbatim and nothing leaves the machine. The model is the stub
 * below: it records every request and answers prose, or JSON when asked.
 *
 * 1. Turn one on a project page retains to the asker's personal bank and to
 *    the project bank.
 * 2. Turn two recalls both, and the stub sees the grounding block.
 * 3. A reviewer run — a runner that calls the model client directly — with no
 *    note recalls the project bank on its subject page's title, never the
 *    personal bank, and retains its outcome to the project bank.
 *
 * Needs `make infra-up`. Not part of `make verify`:
 * `pnpm --filter @knowledge/api run test:e2e agent-memory-runtime`.
 */

const WS = '11670000-0000-4167-8167-000000000001';
const INDEX_TIMEOUT_MS = 120_000;

type ChatRequest = {
  messages: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  response_format?: { type: string };
};

describe('agent memory runtime (e2e, #1167)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let graph: GraphService;
  let model: Server;
  const seen: ChatRequest[] = [];
  const nonce = randomUUID().slice(0, 8);
  const fact = `The ${nonce} retry limit is three attempts.`;
  let alice: { id: string; key: string };
  let projectId: string;
  let documentId: string;
  const keyIds: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (r: request.Test) => r.set('Authorization', `Bearer ${alice.key}`);
  const lastUser = (req: ChatRequest): string =>
    String([...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '');

  /** The first model request since `from` whose last user turn contains `needle`. */
  const requestWith = (from: number, needle: string) =>
    seen.slice(from).find((req) => lastUser(req).includes(needle));

  async function units(bankId: string, documentId: string) {
    return prisma.memoryUnit.findMany({
      where: { documentId, bank: { workspaceId: WS, bankId } },
      select: { text: true, sourceText: true },
    });
  }

  /** Retention is fire-and-forget: poll until it lands. */
  async function waitForUnits(bankId: string, documentId: string) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const rows = await units(bankId, documentId);
      if (rows.length) return rows;
      if (Date.now() > deadline) throw new Error(`nothing retained to ${bankId} for ${documentId}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async function ask(content: string, threadId?: string): Promise<string> {
    const thread =
      threadId ??
      ((await as(http().post('/v1/assistant/threads')).send({ workspaceId: WS, documentId }).expect(201)).body.thread.id as string);
    const reply = await as(http().post(`/v1/assistant/threads/${thread}/messages`))
      .send({ content, mode: 'ask' })
      .expect(201);
    expect(reply.body.enabled).toBe(true);
    return reply.body.assistantMessage.id as string;
  }

  beforeAll(async () => {
    model = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body) as ChatRequest;
      seen.push(parsed);
      const content = parsed.response_format?.type === 'json_object' ? '{"issues":[]}' : fact;
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.end(chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          created: 0,
          model: 'stub',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));

    process.env.AUTH_MODE = 'api-key';
    process.env.MEMORY_ENABLED = 'true';
    process.env.EMBEDDINGS_PROVIDER = 'stub';
    process.env.FULLTEXT_PROVIDER = 'none';
    process.env.EXTRACTOR_PROVIDER = 'none';
    process.env.ASSISTANT_PROVIDER = 'openai-compatible';
    process.env.ASSISTANT_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
    process.env.ASSISTANT_MODEL = 'stub-model';
    process.env.ASSISTANT_API_KEY = 'stub';

    const [{ createE2eApp }, { PrismaService }, { GraphService }, { EMBEDDING_PROVIDER }, { IngestionWorkerModule }, { AgentWorkerModule }] =
      await Promise.all([
        import('./e2e-app.js'),
        import('../src/prisma/prisma.service.js'),
        import('../src/graph/graph.service.js'),
        import('../src/embedding/embedding.provider.js'),
        import('../src/ingestion/ingestion-worker.module.js'),
        import('../src/agents/agent-worker.module.js'),
      ]);
    app = await createE2eApp([IngestionWorkerModule, AgentWorkerModule]);
    prisma = app.get(PrismaService);
    graph = app.get(GraphService);
    await graph.ensureSchema(app.get<{ dimension: number }>(EMBEDDING_PROVIDER).dimension);

    await prisma.workspace.upsert({
      where: { id: WS },
      update: { deletedAt: null },
      create: { id: WS, name: 'Agent memory runtime e2e (#1167)' },
    });
    await prisma.memoryBank.deleteMany({ where: { workspaceId: WS } });
    await graph.deleteMemoryUnits(WS, (await graph.memoryUnitIds(WS)).map((v) => v.unitId));

    const email = 'agent-memory-e2e-alice@example.test';
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: 'Memory e2e Alice', isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: WS, userId: user.id } },
      update: { role: 'editor' },
      create: { workspaceId: WS, userId: user.id, role: 'editor' },
    });
    const key = `kn_${randomBytes(24).toString('hex')}`;
    const row = await prisma.apiKey.create({
      data: {
        userId: user.id,
        name: `agent memory e2e ${nonce}`,
        keyHash: createHash('sha256').update(key).digest('hex'),
        prefix: key.slice(0, 11),
        scope: 'write',
        workspaceId: WS,
      },
    });
    keyIds.push(row.id);
    alice = { id: user.id, key };

    projectId = (await prisma.project.create({ data: { workspaceId: WS, name: `Memory e2e ${nonce}` } })).id;
    const title = `Payments ${nonce} retry policy`;
    const created = await as(http().post('/v1/documents'))
      .send({
        workspaceId: WS,
        visibility: 'workspace',
        projectId,
        title,
        content: { mode: 'inline', format: 'markdown', text: `# ${title}\n\nHow the payments ${nonce} client retries a failed call.\n` },
      })
      .expect(201);
    documentId = created.body.documentId;
    const revisionId: string = created.body.revisionId;
    // A private draft page is its author's alone; the reviewer reads pages the workspace may open.
    await as(http().post(`/v1/documents/${documentId}/publish`)).send({}).expect((r) => {
      if (r.status >= 400 && r.status !== 409) throw new Error(`publish failed: ${r.status} ${JSON.stringify(r.body)}`);
    });
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    for (;;) {
      const rev = await prisma.documentRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { status: true } });
      if (rev.status === 'indexed') break;
      if (rev.status === 'failed' || Date.now() > deadline) throw new Error(`revision ${revisionId} is ${rev.status}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 180_000);

  afterAll(async () => {
    if (app) {
      await prisma.memoryBank.deleteMany({ where: { workspaceId: WS } });
      await graph.deleteMemoryUnits(WS, (await graph.memoryUnitIds(WS)).map((v) => v.unitId));
      await prisma.apiKey.deleteMany({ where: { id: { in: keyIds } } });
      await app.close();
    }
    await new Promise<void>((resolve) => (model ? model.close(() => resolve()) : resolve()));
  });

  it('injects the memory runtime into every caller', async () => {
    // Each takes it as `@Optional()`, so a type-only import resolves to undefined
    // without an error — background runs shipped in #1164 with no memory that way.
    const [{ AgentExecutor }, { MentionRepliesService }, { AssistantService }, { MemoryRuntimeService }] = await Promise.all([
      import('../src/agents/agent.executor.js'),
      import('../src/documents/mention-replies.service.js'),
      import('../src/assistant/assistant.service.js'),
      import('../src/memory/memory-runtime.service.js'),
    ]);
    for (const caller of [AgentExecutor, MentionRepliesService, AssistantService])
      expect((app.get(caller as never) as { memory?: unknown }).memory).toBeInstanceOf(MemoryRuntimeService);
  });

  it('retains an assistant turn to the personal and the project bank', async () => {
    const messageId = await ask(`What is the ${nonce} retry limit?`);
    const personal = await waitForUnits(`agent:researcher:user:${alice.id}`, `assistant-turn:${messageId}`);
    const project = await waitForUnits(`project:${projectId}`, `assistant-turn:${messageId}`);
    expect(personal.map((u) => u.sourceText).join('\n')).toContain(fact);
    expect(project.map((u) => u.sourceText).join('\n')).toContain(fact);
  });

  it('recalls both banks into the next turn', async () => {
    const from = seen.length;
    await ask(`Remind me: the ${nonce} retry limit?`);
    const grounded = requestWith(from, 'Earlier agent work in this project:');
    expect(grounded).toBeDefined();
    const text = lastUser(grounded!);
    expect(text).toContain('Your earlier work with this user:');
    expect(text).toContain(fact);
  });

  it('keeps a thread personal once a turn in it recalled personal memory, even when a later turn recalls none (#1169)', async () => {
    const personalBank = `agent:researcher:user:${alice.id}`;
    const thread = (await as(http().post('/v1/assistant/threads')).send({ workspaceId: WS, documentId }).expect(201)).body.thread.id as string;
    const from = seen.length;
    const first = await ask(`Again, the ${nonce} retry limit?`, thread);
    expect(lastUser(requestWith(from, 'Your earlier work with this user:')!)).toContain(fact);
    await waitForUnits(personalBank, `assistant-turn:${first}`);
    expect((await prisma.assistantThread.findUniqueOrThrow({ where: { id: thread } })).privateContextAt).not.toBeNull();

    // Nothing personal left to recall: turn 2 alone would qualify for the project bank.
    await prisma.memoryBank.deleteMany({ where: { workspaceId: WS, bankId: personalBank } });
    const before = seen.length;
    const second = await ask(`And the ${nonce} timeout?`, thread);
    expect(seen.slice(before).some((req) => lastUser(req).includes('Your earlier work with this user:'))).toBe(false);
    await waitForUnits(personalBank, `assistant-turn:${second}`);
    // Personal is retained first, project after it in the same pass: give the project copy time to (wrongly) land.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await units(`project:${projectId}`, `assistant-turn:${second}`)).toEqual([]);
  });

  it('grounds a direct-call background run on its subject title, and retains its outcome to the project bank only', async () => {
    const [{ AgentExecutor }, { AgentRegistryService }, { AccessService }] = await Promise.all([
      import('../src/agents/agent.executor.js'),
      import('../src/agents/agent-registry.service.js'),
      import('../src/auth/access.service.js'),
    ]);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: WS,
        agentKey: 'reviewer',
        createdBy: alice.id,
        status: 'running',
        input: { documentIds: [documentId] },
      },
    });
    const agent = await app.get(AgentRegistryService).resolve(WS, 'reviewer');
    const principal = await app.get(AccessService).principalFor(alice.id, 'en');
    const from = seen.length;
    await app.get(AgentExecutor).run(run, agent, principal, async () => undefined);

    const grounded = requestWith(from, 'Earlier agent work in this project:');
    expect(grounded).toBeDefined();
    expect(grounded!.response_format?.type).toBe('json_object');
    const text = lastUser(grounded!);
    expect(text).toContain(fact);
    // A run's output is listed to the workspace: the owner's personal bank never grounds it.
    expect(text).not.toContain('Your earlier work with this user:');

    const project = await waitForUnits(`project:${projectId}`, `agent-run:${run.id}`);
    expect(project.length).toBeGreaterThan(0);
    expect(await units(`agent:reviewer:user:${alice.id}`, `agent-run:${run.id}`)).toEqual([]);
  });
});
