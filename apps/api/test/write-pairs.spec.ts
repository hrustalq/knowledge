import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { MergeRequestsService } from '../src/documents/merge-requests.service.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { WorkflowsService } from '../src/workflows/workflows.service.js';
import { ConnectorStagingService } from '../src/connectors/connector-staging.service.js';
import { ConnectorItemsService } from '../src/connectors/connector-items.service.js';
import { ConnectorConflictSweeper } from '../src/connectors/connector-conflict.sweeper.js';
import { ConnectorsService } from '../src/connectors/connectors.service.js';
import { ChatIdentityService } from '../src/chat/chat-identity.service.js';
import { ChatAnswersService } from '../src/chat/chat-answers.service.js';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { ImportService } from '../src/import/import.service.js';
import { AttachmentsService } from '../src/attachments/attachments.service.js';

/**
 * #658: write pairs that must commit together. Each case fails the LAST write
 * of a flow and asserts that nothing the flow wrote before it committed, and
 * that no post-commit effect fired.
 *
 * The fake models `PrismaService`'s contract, not Postgres: a write outside a
 * boundary commits at once; inside `withTransaction` it is buffered and dropped
 * on a throw; a nested boundary joins; `onCommit` runs only after the
 * outermost commit. So these pin where each flow's boundary sits, which is
 * what #658 got wrong. A raw `$transaction` throws, since inside a boundary it
 * would deadlock (prisma/transaction.ts).
 */
type Handler = ((args: any) => unknown) | unknown;

function fakePrisma(handlers: Record<string, Handler>) {
  const committed: string[] = [];
  let buffer: string[] | null = null;
  let effects: Array<() => Promise<unknown>> | null = null;
  const WRITE = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/;

  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => async (args: unknown) => {
          const key = `${model}.${op}`;
          const h = handlers[key];
          const result = typeof h === 'function' ? await (h as (a: unknown) => unknown)(args) : h;
          if (WRITE.test(op)) (buffer ?? committed).push(key);
          return result;
        },
      },
    );

  const prisma = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'then') return undefined;
        if (prop === '$transaction') throw new Error('raw $transaction used');
        if (prop === 'onCommit') {
          return (fn: () => Promise<unknown>) => (effects ? effects.push(fn) : void fn());
        }
        if (prop === 'withTransaction') {
          return async (fn: () => Promise<unknown>) => {
            if (buffer) return fn();
            const own: string[] = [];
            const queued: Array<() => Promise<unknown>> = [];
            buffer = own;
            effects = queued;
            try {
              const result = await fn();
              buffer = null;
              effects = null;
              committed.push(...own);
              for (const e of queued) await e();
              return result;
            } finally {
              buffer = null;
              effects = null;
            }
          };
        }
        return delegate(prop);
      },
    },
  );
  return { prisma: prisma as never, committed };
}

const boom = () => {
  throw new Error('boom');
};
const stub = <T extends object>(target: T, methods: Record<string, unknown>): T => Object.assign(target, methods);
const config = (values: Record<string, unknown>) => ({ get: (k: string) => values[k] }) as never;
const WS = '11111111-1111-4111-8111-111111111111';
/** A dependency the case never reaches. */
const _ = {} as never;

describe('#658 write pairs commit together', () => {
  it('merge request: no MR without its un-restricted branch and subscription', async () => {
    const { prisma, committed } = fakePrisma({
      'document.findUnique': { id: 'd1', workspaceId: WS, title: 'T', defaultBranch: 'main', archivedAt: null },
      'mergeRequest.create': { id: 'mr1', documentId: 'd1' },
      'documentBranch.updateMany': { count: 1 },
    });
    const activity = { record: vi.fn() };
    const notifications = { ensureSubscription: vi.fn(boom) };
    const svc = new MergeRequestsService(prisma, _, _, _, activity as never, _, _, notifications as never, _, _, _, _, _, _, _, _);
    stub(svc, {
      getBranchOrThrow: async (_d: string, name: string) => ({ id: name, name, headRevisionId: 'r1', projectBranchId: null }),
      rejectDuplicateOpen: async () => undefined,
      changedPages: async () => [],
      assertTargetsExist: () => undefined,
    });

    await expect(svc.create('d1', { sourceBranch: 'feature', title: 'x' } as never, 'u1')).rejects.toThrow('boom');
    expect(committed).toEqual([]);
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('PATCH /v1/documents/:id: a rejected patch leaves the owner alone', async () => {
    const { prisma, committed } = fakePrisma({ 'document.update': { id: 'd1' } });
    const activity = { record: vi.fn(async () => undefined) };
    const svc = new DocumentsService(prisma, _, _, _, activity as never, _, _, _, _, _, _, _, _, _, _, _);
    const doc = { id: 'd1', workspaceId: WS, projectId: 'p1', ownerId: 'old', parentId: null, archivedAt: null, title: 'T', path: '/d1/', depth: 0 };
    stub(svc, {
      getDocumentOrThrow: async () => ({ ...doc }),
      assertMember: async () => undefined,
      assertValidParent: async () => {
        throw new BadRequestException('bad parent');
      },
    });

    await expect(svc.updateDocument('d1', { ownerId: 'new', parentId: 'p-elsewhere' } as never, 'u1')).rejects.toThrow('bad parent');
    expect(committed).toEqual([]);
    expect(activity.record).not.toHaveBeenCalled();
  });

  describe('workflows', () => {
    const step = { id: 's1', next: ['s2'] };
    const run = { id: 'run1', workspaceId: WS, status: 'running', snapshot: null, rootDocumentId: 'd1', definitionSnapshot: { steps: [step, { id: 's2', next: [] }] } };

    it('CANCEL: no cancelled run with live nodes', async () => {
      const { prisma, committed } = fakePrisma({
        'workflowRun.update': { ...run, status: 'cancelled', definition: { name: 'W' } },
        'workflowRunNode.updateMany': boom,
      });
      const svc = stub(new WorkflowsService(prisma, { record: vi.fn() } as never, _, _, _, _), {
        requireRun: async () => run,
      });
      await expect(svc.sendRunEvent('run1', 'CANCEL')).rejects.toThrow('boom');
      expect(committed).toEqual([]);
    });

    it('APPROVE: no approved node without its children', async () => {
      const { prisma, committed } = fakePrisma({ 'workflowRunNode.update': { id: 'n1', status: 'approved', attempt: 0 } });
      const runner = { spawnChildren: vi.fn(boom) };
      const svc = stub(new WorkflowsService(prisma, _, _, _, runner as never, _), {
        requireRun: async () => run,
        requireNode: async () => ({ id: 'n1', stepId: 's1', status: 'awaiting-review', draft: null, attempt: 0 }),
      });
      await expect(svc.sendNodeEvent('run1', 'n1', 'APPROVE', undefined, 'u1', vi.fn())).rejects.toThrow('boom');
      expect(runner.spawnChildren).toHaveBeenCalled();
      expect(committed).toEqual([]);
    });

    it('remove: a live run keeps its history and the definition, as a 409', async () => {
      const deleteMany = vi.fn(() => ({ count: 2 }));
      const { prisma, committed } = fakePrisma({
        'workflowRun.deleteMany': deleteMany,
        'workflowDefinition.delete': () => {
          throw Object.assign(new Error('fk'), { code: 'P2003' });
        },
        'workflowRun.count': 1,
      });
      const svc = stub(new WorkflowsService(prisma, { record: vi.fn() } as never, _, _, _, _), {
        requireDefinition: async () => ({ id: 'w1', workspaceId: WS, name: 'W' }),
      });
      const err = await svc.remove('w1').catch((e: unknown) => e);
      expect((err as { getResponse: () => { reason: string } }).getResponse().reason).toBe('runs-in-flight');
      expect(committed).toEqual([]);
      // Only finished runs are ever deleted, so a live one is left for the FK.
      expect(deleteMany).toHaveBeenCalledWith({ where: { definitionId: 'w1', status: { in: ['completed', 'cancelled', 'failed'] } } });
    });
  });

  describe('connectors', () => {
    const row = { id: 'c1', workspaceId: WS, kind: 'confluence', config: {}, projectId: 'p1' };
    const link = { id: 'l1', documentId: 'd1', externalUrl: null };
    const item = { id: 'i1', runId: 'run1', status: 'approved', stagedKey: 'k', linkId: 'l1', documentId: 'd1', action: 'update', draft: null, externalId: 'x', externalVersion: 'v2', externalUrl: null, title: 'T', createdDocument: false, previousRevisionId: 'r0' };
    const revisionWriter = (prisma: never) => ({
      createRevision: vi.fn(async () => {
        await (prisma as { documentRevision: { create: (a: unknown) => Promise<unknown> } }).documentRevision.create({});
        return { revisionId: 'r2' };
      }),
      finalizeRevision: vi.fn(async () => undefined),
      createBranch: vi.fn(async () => {
        await (prisma as { documentBranch: { create: (a: unknown) => Promise<unknown> } }).documentBranch.create({});
      }),
    });
    const storage = { getObjectText: async () => 'md', putObjectText: async () => undefined };
    const reads = {
      'connectorLink.findUnique': link,
      'document.findUnique': { id: 'd1', defaultBranch: 'main' },
      'documentBranch.findUnique': { headRevisionId: 'r1' },
      'documentRevision.findUnique': { s3Key: 's', contentType: 'text/markdown' },
      'documentRevision.findUniqueOrThrow': { s3Key: 's' },
    };

    it('apply: no revision without the link’s contentHash and the item', async () => {
      const { prisma, committed } = fakePrisma({ ...reads, 'connectorRunItem.update': boom });
      const svc = new ConnectorStagingService(prisma, revisionWriter(prisma) as never, storage as never, { applyToPage: vi.fn() } as never, {} as never);
      await expect(svc.apply(row as never, { id: 'run1', mode: 'review' } as never, item as never)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
    });

    it('openConflictBranch: no externalVersion bump without the conflict row', async () => {
      const { prisma, committed } = fakePrisma({ ...reads, 'connectorRunItem.update': boom });
      const svc = new ConnectorStagingService(prisma, revisionWriter(prisma) as never, storage as never, { applyToPage: vi.fn() } as never, {} as never);
      await expect(svc.apply(row as never, { id: 'run1', mode: 'auto' } as never, { ...item, action: 'conflict' } as never)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
    });

    it('revert: no restoring revision without the link and the item', async () => {
      const { prisma, committed } = fakePrisma({ ...reads, 'connectorRun.update': { id: 'run1', workspaceId: WS }, 'connectorRunItem.update': boom });
      const events = { publish: vi.fn() };
      const svc = new ConnectorItemsService(prisma, revisionWriter(prisma) as never, storage as never, {} as never, {} as never, events as never);
      const revert = (svc as unknown as { revertItem: (i: unknown) => Promise<unknown> }).revertItem.bind(svc);
      await expect(revert({ ...item, status: 'applied' })).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('APPROVE_ALL: no approved items under a run still awaiting review', async () => {
      const { prisma, committed } = fakePrisma({ 'connectorRunItem.updateMany': { count: 3 }, 'connectorRun.update': boom });
      const producer = { enqueueRetry: vi.fn(), enqueueTask: vi.fn() };
      const svc = stub(new ConnectorItemsService(prisma, {} as never, {} as never, producer as never, {} as never, {} as never), {
        requireRun: async () => ({ id: 'run1', status: 'awaiting-review', mode: 'review', phase: null, discovered: 3, applied: 0 }),
        awaitingCount: async () => 3,
      });
      await expect(svc.sendRunEvent('run1', 'APPROVE_ALL')).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(producer.enqueueRetry).not.toHaveBeenCalled();
    });

    it('conflict sweeper: no open MR under a pending conflict', async () => {
      const conflict = { id: 'cf1', documentId: 'd1', reason: 'conflict', connector: { locale: 'en', createdBy: null } };
      const { prisma, committed } = fakePrisma({
        'connectorConflict.findMany': [conflict],
        'connectorConflict.update': ({ data }: { data: { status: string } }) => (data.status === 'resolved' ? boom() : {}),
      });
      const mergeRequests = {
        create: vi.fn(async () => {
          await (prisma as { mergeRequest: { create: (a: unknown) => Promise<unknown> } }).mergeRequest.create({});
          return { mergeRequest: { mergeRequestId: 'mr1' } };
        }),
      };
      const sweeper = stub(new ConnectorConflictSweeper(prisma, mergeRequests as never, {} as never), {
        mergeRequestText: async () => ({ sourceBranch: 'connector/x', title: 'T' }),
      });
      await sweeper.sweep();
      // Only the failure record, which must survive the rollback.
      expect(committed).toEqual(['connectorConflict.update']);
    });

    it('a webhook merge the worker raced gets a run of its own', async () => {
      const { prisma } = fakePrisma({
        'connectorRun.findFirst': { id: 'run1', scope: ['a'] },
        'connectorRun.updateMany': { count: 0 },
        'connectorRun.create': ({ data }: { data: { scope: string[] } }) => ({ id: 'run2', scope: data.scope }),
      });
      const svc = new ConnectorsService(prisma, config({}), _, _, _, _);
      const created = await svc.queueWebhookRefs({ id: 'c1', workspaceId: WS, enabled: true, locale: 'en' } as never, ['b']);
      expect(created).toMatchObject({ id: 'run2', scope: ['b'] });
    });
  });

  it('chat link: no spent code without an identity', async () => {
    const { prisma, committed } = fakePrisma({ 'chatLinkCode.updateMany': { count: 1 }, 'chatIdentity.upsert': boom });
    const svc = stub(new ChatIdentityService(prisma, {} as never, {} as never, {} as never, config({ CHAT_LINK_CODE_TTL_MINUTES: 10, WEB_BASE_URL: 'http://x' })), {
      redeemable: async () => ({ row: { id: 'code1', externalUserId: '42', externalUserName: null, externalChatId: '42' }, integration: { id: 'int1', workspaceId: WS } }),
      assertMember: async () => undefined,
    });
    await expect(svc.confirm('code', { userId: 'u1' } as never)).rejects.toThrow('boom');
    expect(committed).toEqual([]);
  });

  it('chat answer: no assistant thread without its conversation', async () => {
    const { prisma, committed } = fakePrisma({ 'chatConversation.create': boom });
    const threads = {
      createThread: async () => {
        await (prisma as { assistantThread: { create: (a: unknown) => Promise<unknown> } }).assistantThread.create({});
        return { thread: { id: 't1' } };
      },
    };
    const svc = new ChatAnswersService(prisma, _, _, threads as never, _, _, _, _, _, _, _, _, config({ WEB_BASE_URL: 'http://x' }));
    const conversationFor = (svc as unknown as { conversationFor: (...a: unknown[]) => Promise<unknown> }).conversationFor.bind(svc);
    await expect(conversationFor({ integration: { id: 'int1', workspaceId: WS }, inbound: { chatId: 'c', isDm: false } }, 'u1', 'q?')).rejects.toThrow('boom');
    expect(committed).toEqual([]);
  });

  describe('auth', () => {
    const auth = (prisma: never, mail = { enqueue: vi.fn() }) =>
      new AuthFlowService(prisma, config({ AUTH_SIGNUP_ENABLED: true, AUTH_DEFAULT_WORKSPACE_ID: WS }), {} as never, mail as never, {} as never, {} as never);

    it('verifyEmail: no spent token with the address unverified', async () => {
      const { prisma, committed } = fakePrisma({
        'emailVerificationToken.findUnique': { id: 't1', userId: 'u1', email: 'a@x.test', expiresAt: new Date(Date.now() + 60_000), user: { email: 'a@x.test', disabledAt: null, emailVerifiedAt: null } },
        'emailVerificationToken.updateMany': { count: 1 },
        'user.updateMany': boom,
      });
      await expect(auth(prisma).verifyEmail('kv_x')).rejects.toThrow('boom');
      expect(committed).toEqual([]);
    });

    it('signup: no user without the default membership, and no mail', async () => {
      const { prisma, committed } = fakePrisma({
        'user.findUnique': null,
        'user.create': { id: 'u1', email: 'a@x.test' },
        'workspace.findUnique': { id: WS },
        'workspaceMember.upsert': boom,
      });
      const mail = { enqueue: vi.fn() };
      const svc = stub(auth(prisma, mail), { passwordBlockedBy: async () => null });
      await expect(svc.signup('a@x.test', 'A', 'correct horse battery')).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(mail.enqueue).not.toHaveBeenCalled();
    });
  });

  it('import: the row is written once, with its key', async () => {
    const create = vi.fn(({ data }: { data: Record<string, unknown> }) => ({ ...data, status: 'uploading', createdAt: new Date(), updatedAt: new Date() }));
    const { prisma, committed } = fakePrisma({ 'importJob.create': create });
    const storage = { importObjectKey: (ws: string, id: string, f: string) => `w/${ws}/imports/${id}/${f}`, presignPut: async () => 'url' };
    const svc = new ImportService(prisma, storage as never, { requireProjectInWorkspace: async () => undefined } as never, _, _, _, _, config({ IMPORT_MAX_BYTES: 1e9 }));
    await svc.create({ workspaceId: WS, projectId: 'p1', filename: 'a.md', contentType: 'text/markdown', sizeBytes: 10 } as never).catch(() => undefined);
    expect(committed).toEqual(['importJob.create']);
    const data = create.mock.calls[0][0].data as { id: string; s3Key: string };
    expect(data.s3Key).toBe(`w/${WS}/imports/${data.id}/a.md`);
  });

  it('attachment over the limit: the row goes before the object', async () => {
    const { prisma } = fakePrisma({ 'attachment.delete': boom });
    const storage = { headObject: async () => ({ contentLength: 10_000 }), deleteObject: vi.fn() };
    const svc = stub(new AttachmentsService(prisma, storage as never, {} as never, config({ ATTACHMENT_MAX_BYTES: 10 })), {
      require: async () => ({ id: 'a1', s3Key: 'k' }),
    });
    await expect(svc.complete('d1', 'a1')).rejects.toThrow('boom');
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
