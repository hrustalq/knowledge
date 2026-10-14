import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChatCapturesService, chatTranscript, splitDraft, type CaptureRequest } from '../src/chat/chat-captures.service.js';
import type { ChatView } from '../src/chat/adapters/chat-adapter.types.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';

/**
 * Saving a chat conversation (issue #71, phase 2). What is pinned: only what
 * was shown in the chat is saved, as untrusted input; a page arrives as a
 * merge request attributed to the person who pressed Save and nothing is
 * published; a term arrives switched off; an editor is required at the moment
 * of writing; and a double press, a retry and a sweeper that got there first
 * each end in exactly one outcome.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const integration = { id: 'int-1', workspaceId: WS, kind: 'telegram', name: 'Team bot', botUsername: 'kn_bot' } as never;

const thread = [
  { id: 'q1', role: 'user', content: 'How do we deploy?', sources: [] },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Through CI [S1].',
    sources: [{ documentId: 'd1', title: 'Deploy guide', cite: 'S1' }],
  },
  // Carried on in /assistant afterwards — never posted in the chat.
  { id: 'q2', role: 'user', content: 'And my private notes?', sources: [] },
  { id: 'a2', role: 'assistant', content: 'Secret.', sources: [] },
];

describe('chatTranscript', () => {
  it('keeps only the turns shown in the chat, with citations as page links', () => {
    const text = chatTranscript(thread, new Set(['a1']));
    expect(text).toBe('Question: How do we deploy?\n\nAnswer:\nThrough CI ([Deploy guide](/documents/d1)).');
    expect(text).not.toContain('Secret');
  });
});

describe('splitDraft', () => {
  it('takes the title from the first heading and the page after it', () => {
    expect(splitDraft('# Deploying\n\nRun the pipeline.', 'x')).toEqual({ title: 'Deploying', body: 'Run the pipeline.' });
  });

  it('unwraps a fenced answer and falls back when there is no heading', () => {
    expect(splitDraft('```markdown\nJust a body.\n```', 'From chat')).toEqual({ title: 'From chat', body: 'Just a body.' });
  });
});

function harness(opts: {
  claimTaken?: 'pending' | 'published' | 'failed-retry';
  editorAtWrite?: boolean;
  reaperWon?: boolean;
  draft?: string;
  suggestions?: Array<{ term: string; definition: string; aliases: string[]; existingTermId: string | null }>;
} = {}) {
  const posted: ChatView[] = [];
  const edited: ChatView[] = [];
  const adapter = {
    render: (view: ChatView) => ({ text: '', plain: '', buttons: [], view }),
    postMessage: vi.fn(async (_c: unknown, target: { chatId: string }, msg: { view: ChatView }) => {
      posted.push(msg.view);
      return { chatId: target.chatId, messageId: `bot-${posted.length}` };
    }),
    editMessage: vi.fn(async (_c: unknown, _r: unknown, msg: { view: ChatView }) => {
      edited.push(msg.view);
    }),
  };
  const capture = { id: 'cap-12345678', status: 'pending', title: null, mergeRequestId: null };
  const settled: Array<Record<string, unknown>> = [];
  const prisma = {
    withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    chatCapture: {
      create: vi.fn(async () => {
        if (opts.claimTaken) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        return capture;
      }),
      findUniqueOrThrow: vi.fn(async () => ({
        ...capture,
        ...(opts.claimTaken === 'published' ? { status: 'published', title: 'Deploying', mergeRequestId: 'mr-0' } : {}),
      })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async ({ where, data }: { where: { status: string }; data: Record<string, unknown> }) => {
        if (where.status === 'failed') return { count: opts.claimTaken === 'failed-retry' ? 1 : 0 };
        if (data.status === 'published' && opts.reaperWon) return { count: 0 };
        settled.push(data);
        return { count: 1 };
      }),
      findMany: vi.fn(async () => []),
    },
    chatConversation: { findUnique: vi.fn(async () => ({ assistantThreadId: 'thread-1' })) },
    chatAnswer: { findMany: vi.fn(async () => [{ assistantMessageId: 'a1' }]) },
    assistantMessage: { findMany: vi.fn(async () => thread) },
    project: { findFirst: vi.fn(async () => ({ id: 'p-first' })) },
    documentRevision: { findUnique: vi.fn(async () => ({ id: 'rev-2', s3Key: 'k/source.md' })) },
  };
  let roleChecks = 0;
  const access = {
    requireRole: vi.fn(async () => {
      roleChecks++;
      if (opts.editorAtWrite === false) throw new ForbiddenException('not an editor any more');
    }),
  };
  const documents = {
    createDocument: vi.fn(async () => ({ documentId: 'doc-new' })),
    createBranch: vi.fn(async () => ({})),
    createRevision: vi.fn(async () => ({ revisionId: 'rev-2' })),
    finalizeRevision: vi.fn(async () => ({})),
  };
  const mergeRequests = { create: vi.fn(async () => ({ mergeRequest: { mergeRequestId: 'mr-1' } })) };
  const storage = { putObjectText: vi.fn(async () => undefined) };
  const glossary = {
    suggest: vi.fn(async () => ({ enabled: true, projectId: 'p-1', suggestions: opts.suggestions ?? [] })),
    create: vi.fn(async (dto: { term: string }) => ({ termId: 'term-1', term: dto.term })),
  };
  const agents = {
    resolve: vi.fn(async () => ({ key: 'drafter', enabled: true, instructions: 'You draft.', config: { enabled: true } })),
  };
  const client = { chat: vi.fn(async () => opts.draft ?? '# Deploying\n\nDeploys go through CI ([Deploy guide](/documents/d1)).') };
  const aiUsage = { assertWithinBudget: vi.fn(async () => undefined) };
  const config = {
    get: (key: string) => ({ WEB_BASE_URL: 'https://kn.test', CHAT_CAPTURE_TIMEOUT_SECONDS: 300 })[key],
  };
  const svc = new ChatCapturesService(
    prisma as never,
    access as never,
    documents as never,
    mergeRequests as never,
    storage as never,
    glossary as never,
    agents as never,
    client as never,
    aiUsage as never,
    { get: () => adapter } as never,
    { context: () => ({ token: 'T', botUsername: 'kn_bot', serverUrl: null, actionUrl: '' }) } as never,
    config as never,
  );
  const request = (over: Partial<CaptureRequest> = {}): CaptureRequest => ({
    integration,
    adapter: adapter as never,
    ctx: { token: 'T', botUsername: 'kn_bot', serverUrl: null, actionUrl: '' },
    answerMessage: { chatId: '-100', messageId: 'bot-answer' },
    answer: { id: 'ans-1', conversationId: 'conv-1', createdAt: new Date('2026-10-14T10:00:00Z') },
    projectId: 'p-1',
    principal: { ...DEV_PRINCIPAL, userId: 'u-editor' },
    kind: 'page',
    locale: 'en',
    workspaceName: 'Acme',
    ...over,
  });
  return {
    svc,
    request,
    prisma,
    documents,
    mergeRequests,
    storage,
    glossary,
    client,
    posted,
    edited,
    settled,
    roleChecks: () => roleChecks,
  };
}

describe('save as a page', () => {
  it('drafts from the shown turns, then opens a merge request as the requester — nothing published', async () => {
    const h = harness();
    await h.svc.start(h.request());

    expect(h.posted).toEqual([{ kind: 'notice', text: 'chat.capture.draftingPage' }]);
    const [ctx, messages] = h.client.chat.mock.calls[0] as unknown as [
      { operation: string; userId: string },
      Array<{ role: string; content: string }>,
    ];
    expect(ctx).toMatchObject({ operation: 'chat-capture', userId: 'u-editor' });
    expect(messages[1].content).toMatch(/^<chat tool="save_thread">/);
    expect(messages[1].content).toContain('Question: How do we deploy?');
    expect(messages[1].content).not.toContain('Secret');

    // Created empty, the body only on the branch behind the merge request.
    expect(h.documents.createDocument).toHaveBeenCalledWith({ workspaceId: WS, projectId: 'p-1', title: 'Deploying' }, 'u-editor');
    const [, body] = h.storage.putObjectText.mock.calls[0] as unknown as [string, string];
    expect(body).toMatch(/^---\nsource: '?chat:telegram'?\ngeneratedBy: drafter\n---\n/);
    expect(body).toContain('[Deploy guide](/documents/d1)');
    expect(h.mergeRequests.create).toHaveBeenCalledWith('doc-new', expect.objectContaining({ title: 'Deploying' }), 'u-editor');

    expect(h.settled).toEqual([{ status: 'published', title: 'Deploying', documentId: 'doc-new', mergeRequestId: 'mr-1' }]);
    expect(h.edited).toEqual([
      {
        kind: 'notice',
        text: 'chat.capture.pageReady',
        button: { label: 'chat.capture.openMergeRequest', url: 'https://kn.test/merge-requests/mr-1' },
      },
    ]);
  });

  it('a DM saves into the workspace’s first project', async () => {
    const h = harness();
    await h.svc.start(h.request({ projectId: null }));
    expect(h.documents.createDocument).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-first' }), 'u-editor');
  });

  it('an editor who is no longer one when the draft is in writes nothing', async () => {
    const h = harness({ editorAtWrite: false });
    await h.svc.start(h.request());
    expect(h.roleChecks()).toBe(1);
    expect(h.documents.createDocument).not.toHaveBeenCalled();
    expect(h.settled).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(h.edited).toEqual([{ kind: 'notice', text: 'chat.capture.forbidden' }]);
  });

  it('a sweeper that already failed it rolls the publish back and leaves its notice', async () => {
    const h = harness({ reaperWon: true });
    await h.svc.start(h.request());
    expect(h.mergeRequests.create).toHaveBeenCalled(); // inside the transaction that then throws
    expect(h.settled).toEqual([]);
    expect(h.edited).toEqual([]);
  });
});

describe('the claim', () => {
  it('a second press while one is drafting saves once', async () => {
    const h = harness({ claimTaken: 'pending' });
    await h.svc.start(h.request());
    expect(h.client.chat).not.toHaveBeenCalled();
    expect(h.posted).toEqual([{ kind: 'notice', text: 'chat.capture.inProgress' }]);
  });

  it('a press after it was saved links what was saved', async () => {
    const h = harness({ claimTaken: 'published' });
    await h.svc.start(h.request());
    expect(h.client.chat).not.toHaveBeenCalled();
    expect(h.posted[0]).toMatchObject({
      text: 'chat.capture.alreadySaved',
      button: { url: 'https://kn.test/merge-requests/mr-0' },
    });
  });

  it('a press after a failure claims the same row again and retries', async () => {
    const h = harness({ claimTaken: 'failed-retry' });
    await h.svc.start(h.request());
    expect(h.client.chat).toHaveBeenCalledOnce();
    expect(h.settled[0]).toMatchObject({ status: 'published' });
  });
});

describe('save as a glossary term', () => {
  const suggestions = [
    { term: 'CI', definition: 'Known already.', aliases: [], existingTermId: 'term-0' },
    { term: 'Pipeline', definition: 'The CI run that deploys.', aliases: ['pipelines'], existingTermId: null },
  ];

  it('creates the first term the project lacks, switched off, as the requester', async () => {
    const h = harness({ suggestions });
    await h.svc.start(h.request({ kind: 'glossary-term' }));
    const [dto] = h.glossary.suggest.mock.calls[0] as unknown as [{ markdown: string; projectId: string }];
    expect(dto.projectId).toBe('p-1');
    expect(dto.markdown).toMatch(/^<chat tool="save_thread">/);
    expect(h.glossary.create).toHaveBeenCalledWith(
      {
        workspaceId: WS,
        projectId: 'p-1',
        term: 'Pipeline',
        definition: 'The CI run that deploys.',
        aliases: ['pipelines'],
        source: 'ai',
        enabled: false,
      },
      'u-editor',
    );
    expect(h.settled).toEqual([{ status: 'published', title: 'Pipeline', glossaryTermId: 'term-1' }]);
    expect(h.edited[0]).toMatchObject({ text: 'chat.capture.termReady', button: { url: 'https://kn.test/settings/glossary' } });
  });

  it('says so when every term is already defined', async () => {
    const h = harness({ suggestions: suggestions.slice(0, 1) });
    await h.svc.start(h.request({ kind: 'glossary-term' }));
    expect(h.glossary.create).not.toHaveBeenCalled();
    expect(h.edited).toEqual([{ kind: 'notice', text: 'chat.capture.noTerm' }]);
  });
});

describe('reapStale', () => {
  it('fails what made no progress and edits its notice, once', async () => {
    const h = harness();
    const row = {
      id: 'cap-9',
      replyMessageId: 'bot-7',
      locale: 'ru',
      answer: { externalChatId: '-100', integration },
    };
    h.prisma.chatCapture.findMany.mockResolvedValueOnce([row, { ...row, id: 'cap-10' }] as never);
    h.prisma.chatCapture.updateMany
      .mockResolvedValueOnce({ count: 1 } as never)
      .mockResolvedValueOnce({ count: 0 } as never);
    expect(await h.svc.reapStale()).toBe(1);
    expect(h.edited).toEqual([{ kind: 'notice', text: 'chat.capture.timeout' }]);
  });
});
