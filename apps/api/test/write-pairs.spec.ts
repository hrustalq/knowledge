import { WIKI_AUTO_REGENERATE_CONFIG_KEY, WIKI_CONFIG_KEY } from '@knowledge/contracts';
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
import { Prisma } from '@prisma/client';
import { IdentityProvidersService } from '../src/auth/sso/identity-providers.service.js';
import { SsoFlowService } from '../src/auth/sso/sso-flow.service.js';
import { GroupMappingsService } from '../src/auth/sso/group-mappings.service.js';
import { RoleSyncService } from '../src/auth/sso/role-sync.service.js';
import { UsersService } from '../src/users/users.service.js';
import { ScimService } from '../src/scim/scim.service.js';
import { hashPassword } from '../src/auth/password.js';
import { fakeWriteRevision } from './revision-fakes.js';
import { AssistantToolsService } from '../src/assistant/assistant.tools.js';
import { AgentFindingsService } from '../src/ai/agent-findings.service.js';
import { McpService } from '../src/mcp/mcp.service.js';

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
        if (prop === '$executeRaw') {
          return async () => ((buffer ?? committed).push('$executeRaw'), (handlers.$executeRaw as number | undefined) ?? 1);
        }
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
    const commits = { lock: async () => undefined, uniqueSlug: async () => 't' };
    const svc = new DocumentsService(prisma, _, _, _, activity as never, _, _, _, _, _, _, _, _, _, _, commits as never);
    const doc = { id: 'd1', workspaceId: WS, projectId: 'p1', ownerId: 'old', parentId: null, archivedAt: null, title: 'T', path: '/d1/', depth: 0 };
    stub(svc, {
      getDocumentOrThrow: async () => ({ ...doc }),
      assertMember: async () => undefined,
      toSummary: async () => ({}),
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
        'workflowRun.updateMany': { count: 1 },
        'workflowRun.findUniqueOrThrow': { ...run, status: 'cancelled', definition: { name: 'W' } },
        'workflowRunNode.updateMany': boom,
      });
      const svc = stub(new WorkflowsService(prisma, { record: vi.fn() } as never, _, _, _, _), {
        requireRun: async () => run,
      });
      await expect(svc.sendRunEvent('run1', 'CANCEL', { bypass: true } as never)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
    });

    it('APPROVE: no approved node without its children', async () => {
      const { prisma, committed } = fakePrisma({
        'workflowRunNode.updateMany': { count: 1 },
        'workflowRunNode.findUniqueOrThrow': { id: 'n1', status: 'approved', attempt: 0 },
      });
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
    const storage = { getObjectText: async () => 'md', putObjectText: async () => undefined };
    const revisionWriter = (prisma: never) => {
      const documents = {
        createRevision: vi.fn(async () => {
          await (prisma as { documentRevision: { create: (a: unknown) => Promise<unknown> } }).documentRevision.create({});
          return { revisionId: 'r2' };
        }),
        finalizeRevision: vi.fn(async () => undefined),
        createBranch: vi.fn(async () => {
          await (prisma as { documentBranch: { create: (a: unknown) => Promise<unknown> } }).documentBranch.create({});
        }),
      };
      return Object.assign(documents, { writeRevision: fakeWriteRevision({ documents, storage, prisma }) });
    };
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
      const { prisma, committed } = fakePrisma({ 'connectorRunItem.updateMany': { count: 3 }, 'connectorRunItem.findMany': [], 'connectorRun.updateMany': boom });
      const producer = { enqueueRetry: vi.fn(), enqueueTask: vi.fn() };
      const svc = stub(new ConnectorItemsService(prisma, {} as never, {} as never, producer as never, {} as never, {} as never), {
        requireRun: async () => ({ id: 'run1', status: 'awaiting-review', mode: 'review', phase: null, discovered: 3, applied: 0 }),
        awaitingCount: async () => 3,
      });
      await expect(svc.sendRunEvent('run1', 'APPROVE_ALL', { bypass: true } as never)).rejects.toThrow('boom');
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

    it('all three run creators freeze the connector\'s review mode (#764)', async () => {
      const { prisma } = fakePrisma({
        'connectorRun.findFirst': null,
        'connectorRun.create': ({ data }: { data: { mode: string } }) => data,
      });
      const svc = new ConnectorsService(prisma, config({}), _, _, _, _);
      Object.assign(svc, { adapterFor: () => ({ capabilities: { pull: true } }), assertKindEnabled: () => undefined });
      const row = {
        id: 'c1',
        workspaceId: WS,
        enabled: true,
        locale: 'en',
        syncMode: 'review',
        direction: 'pull',
        kind: 'codebase',
        config: { [WIKI_CONFIG_KEY]: 'on', [WIKI_AUTO_REGENERATE_CONFIG_KEY]: 'on-push', branch: 'main' },
      };
      expect(await svc.queueWebhookRefs(row as never, ['b'])).toMatchObject({ mode: 'review' });
      expect(await svc.createRun(row as never, 'pull', 'manual', { actorId: undefined })).toMatchObject({ mode: 'review' });
      expect(await svc.queueRepoPush(row as never, { branch: 'main' })).toMatchObject({ mode: 'review' });
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

/**
 * #656: a security change and the revoke/offboard it demands commit together.
 * Each case fails the step after the change and asserts that neither is
 * committed — a retry of every one of these is refused, so a half-commit would
 * leave sessions alive for good — and that no audit row or mail went out.
 */
describe('#656 revoke and offboard commit with the change', () => {
  const U = '22222222-2222-4222-8222-222222222222';
  const G = '33333333-3333-4333-8333-333333333333';
  const P = '44444444-4444-4444-8444-444444444444';
  const audit = () => ({ record: vi.fn(async () => undefined) });
  const failingSessions = () => ({ revokeAllForUser: vi.fn(boom) });
  const scimConfig = config({ API_PUBLIC_URL: 'http://x', AUTH_SCIM_MAX_PAGE: 100, AUTH_SCIM_ENABLED: true, AUTH_MODE: 'api-key' });
  const caller = { workspaceId: WS, tokenId: 't1' };

  it.each(['session.updateMany', 'identityProvider.delete'])('provider delete, %s fails: the provider stays while its sessions stay', async (failing) => {
    const { prisma, committed } = fakePrisma({
      'identityProvider.findFirst': { id: P, workspaceId: WS, kind: 'oidc', name: 'IdP' },
      'session.updateMany': { count: 2 },
      'identityProvider.delete': {},
      [failing]: boom,
    });
    const a = audit();
    const oidc = { forget: vi.fn() };
    const policy = { invalidate: vi.fn() };
    const svc = new IdentityProvidersService(prisma, config({}), oidc as never, a as never, policy as never, _, _);
    await expect(svc.remove(WS, P, { userId: 'u1' } as never)).rejects.toThrow('boom');
    expect(committed).toEqual([]);
    expect(a.record).not.toHaveBeenCalled();
    expect(oidc.forget).not.toHaveBeenCalled();
  });

  describe('back-channel logout', () => {
    const flow = (prisma: never, a: ReturnType<typeof audit>) =>
      new SsoFlowService(
        prisma,
        config({ WEB_BASE_URL: 'http://x', AUTH_SSO_STATE_TTL_SEC: 600 }),
        { logoutClaims: async () => ({ jti: 'j1', sid: 's1', sub: 'sub1' }) } as never,
        _,
        _,
        a as never,
        _,
        _,
        _,
      );
    const provider = { id: P, workspaceId: WS, kind: 'oidc', enabled: true };

    it('no spent jti without the revoke, so the IdP can retry', async () => {
      const { prisma, committed } = fakePrisma({
        'identityProvider.findFirst': provider,
        'ssoAuthRequest.create': {},
        'userIdentity.findUnique': { userId: U },
        'session.updateMany': boom,
      });
      const a = audit();
      await expect(flow(prisma, a).backchannelLogout(P, 'tok', { ip: null } as never)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(a.record).not.toHaveBeenCalled();
    });

    it('a replayed token is still refused, with the same reason', async () => {
      const { prisma, committed } = fakePrisma({
        'identityProvider.findFirst': provider,
        'ssoAuthRequest.create': () => {
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        },
      });
      const a = audit();
      await expect(flow(prisma, a).backchannelLogout(P, 'tok', { ip: null } as never)).resolves.toBe(false);
      expect(committed).toEqual([]);
      expect(a.record).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'logout token replayed' }));
    });
  });

  describe('passwords', () => {
    const auth = (prisma: never, mail: { enqueue: ReturnType<typeof vi.fn> }) =>
      new AuthFlowService(prisma, config({}), failingSessions() as never, mail as never, {} as never, {} as never);

    it('resetPassword: the token stays unspent and the old hash stays', async () => {
      const { prisma, committed } = fakePrisma({
        'passwordResetToken.findUnique': { id: 'rt1', userId: U, usedAt: null, expiresAt: new Date(Date.now() + 60_000), purpose: 'reset' },
        'passwordResetToken.updateMany': { count: 1 },
        'user.update': {},
        'user.updateMany': { count: 0 },
      });
      const mail = { enqueue: vi.fn() };
      await expect(auth(prisma, mail).resetPassword('kr_x', 'correct horse battery')).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(mail.enqueue).not.toHaveBeenCalled();
    });

    it('changePassword: the old hash stays', async () => {
      const { prisma, committed } = fakePrisma({
        'user.findUnique': { id: U, passwordHash: await hashPassword('old password 1') },
        'user.update': {},
      });
      const mail = { enqueue: vi.fn() };
      const principal = { mode: 'api-key', userId: U, sessionId: 's1' } as never;
      await expect(auth(prisma, mail).changePassword(principal, 'old password 1', 'new password 2')).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(mail.enqueue).not.toHaveBeenCalled();
    });

    it('admin disable: the account is not disabled while its sessions live', async () => {
      const { prisma, committed } = fakePrisma({ 'user.findUnique': { id: U, disabledAt: null }, 'user.update': {} });
      const mail = { enqueue: vi.fn() };
      const svc = new UsersService(prisma, failingSessions() as never, mail as never, config({}), _);
      await expect(svc.update({ userId: 'u1' } as never, U, { disabled: true, password: 'override password 3' })).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(mail.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('SCIM', () => {
    const scim = (prisma: never, opts: { roleSync?: unknown; sessions?: unknown; a?: ReturnType<typeof audit> } = {}) =>
      new ScimService(prisma, (opts.roleSync ?? { applyScim: vi.fn(async () => []) }) as never, (opts.sessions ?? failingSessions()) as never, (opts.a ?? audit()) as never, scimConfig);
    const call = <T>(svc: ScimService, method: string, ...args: unknown[]) =>
      (svc as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[method](...args);
    const rec = { userId: U, userName: 'a@x.test', externalId: null, active: true, user: { email: 'a@x.test', displayName: 'A' } };

    it('createUser active=false: no scim_users row without the offboard', async () => {
      const { prisma, committed } = fakePrisma({
        'scimUser.findFirst': null,
        'ssoDomain.findFirst': null,
        'user.findUnique': null,
        'user.create': { id: U },
        'scimUser.create': {},
      });
      const a = audit();
      const body = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'a@x.test', active: false, emails: [{ value: 'a@x.test', primary: true }] };
      await expect(scim(prisma, { a }).createUser(caller, body)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(a.record).not.toHaveBeenCalled();
    });

    it('deleteUser: the row stays while access and sessions stay (through the real role sync)', async () => {
      const { prisma, committed } = fakePrisma({
        'scimUser.findUnique': rec,
        'ssoDomain.findFirst': null,
        'scimGroupMember.deleteMany': {},
        'scimUser.deleteMany': {},
        'scimUser.findMany': [],
        'scimGroupMember.findMany': [],
        'idpGroupMapping.findMany': [],
        'workspaceMember.findMany': [{ workspaceId: WS, userId: U, role: 'editor', trustedOperator: false, source: 'scim' }],
        'workspaceSettings.findUnique': null,
        'userGroupMember.deleteMany': {},
        'accessGrant.deleteMany': {},
      });
      const a = audit();
      // Real RoleSyncService: removeMemberGuarded → dropWorkspaceAccess, which must join the boundary, not open a raw $transaction.
      const roleSync = new RoleSyncService(prisma, a as never);
      await expect(scim(prisma, { roleSync, a }).deleteUser(caller, U)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(a.record).not.toHaveBeenCalled();
    });

    it('deactivate: active stays true, so a retry still offboards', async () => {
      const { prisma, committed } = fakePrisma({ 'ssoDomain.findFirst': null, 'scimUser.update': {} });
      const a = audit();
      const fields = { userName: rec.userName, externalId: null, active: false, email: rec.user.email, displayName: 'A', raw: {} };
      await expect(call(scim(prisma, { a }), 'update', caller, rec, fields)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(a.record).not.toHaveBeenCalled();
    });

    const failingSync = () => ({ applyScim: vi.fn(boom) });
    const group = { id: G, workspaceId: WS, displayName: 'G', externalId: null, members: [{ userId: U, user: { displayName: 'A' } }] };

    it('group update: removed members stay while their re-sync fails', async () => {
      const { prisma, committed } = fakePrisma({ 'scimGroupMember.deleteMany': {} });
      const next = { displayName: 'G', externalId: null, members: new Set<string>() };
      await expect(call(scim(prisma, { roleSync: failingSync() }), 'writeGroup', caller, group, next)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
    });

    it('group delete: the group stays while its re-sync fails', async () => {
      const { prisma, committed } = fakePrisma({ 'scimGroup.findFirst': group, 'scimGroup.delete': {}, 'idpGroupMapping.deleteMany': {} });
      await expect(scim(prisma, { roleSync: failingSync() }).deleteGroup(caller, G)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
    });

    it('group create: no members without their grant', async () => {
      const { prisma, committed } = fakePrisma({ 'scimGroup.create': { id: G }, 'scimUser.findMany': [{ userId: U }], 'scimGroupMember.createMany': {} });
      const body = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'G', members: [{ value: U }] };
      await expect(scim(prisma, { roleSync: failingSync() }).createGroup(caller, body)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
    });

    it('SCIM mapping delete: the mapping stays while its re-sync fails', async () => {
      const { prisma, committed } = fakePrisma({
        'idpGroupMapping.findFirst': { id: 'm1', workspaceId: WS, providerId: null, externalGroup: G, role: 'editor', trustedOperator: false },
        'idpGroupMapping.delete': {},
        'scimGroupMember.findMany': [{ userId: U }],
      });
      const a = audit();
      const svc = new GroupMappingsService(prisma, a as never, failingSync() as never, scimConfig);
      await expect(svc.remove(WS, 'm1', { userId: 'u1' } as never)).rejects.toThrow('boom');
      expect(committed).toEqual([]);
      expect(a.record).not.toHaveBeenCalled();
    });
  });
});

/**
 * #806: finalize decides under the project lock. The fake's writes buffer and
 * drop as in the cases above; the handlers below keep the state a second call
 * would see after the first committed.
 */
describe('#806 finalize decides under the lock', () => {
  function rig(head: string | null, parents: string[], staleReads = 0) {
    const rev = { id: 'r2', documentId: 'd1', status: 'draft', s3Key: 'k', branchId: 'b1', collabDraftId: null, authorId: 'u1', revisionNumber: 2 };
    const branch = { id: 'b1', name: 'main', headRevisionId: head, restricted: false };
    const { prisma, committed } = fakePrisma({
      'document.findUnique': { id: 'd1', workspaceId: WS, projectId: 'p1', title: 'T', defaultBranch: 'main', archivedAt: null, kind: 'page' },
      // The first `staleReads` reads are the unlocked one at the top of a call
      // that started before the other committed.
      'documentRevision.findUnique': () => ({ ...rev, status: staleReads-- > 0 ? 'draft' : rev.status }),
      'documentRevision.updateMany': ({ where }: any) => {
        if (rev.status !== where.status) return { count: 0 };
        rev.status = 'finalized';
        return { count: 1 };
      },
      'documentBranch.findFirstOrThrow': () => ({ ...branch }),
      'documentRevision.findFirst': null,
      'revisionParent.findMany': parents.map((parentRevisionId) => ({ parentRevisionId })),
      'documentBranch.updateMany': ({ where }: any) => {
        const ok = branch.headRevisionId === null || where.OR[1].headRevisionId.in.includes(branch.headRevisionId);
        if (ok) branch.headRevisionId = rev.id;
        return { count: ok ? 1 : 0 };
      },
      'ingestionJob.create': { id: 'j1' },
    });
    const storage = { headObject: async () => ({ versionId: 'v1' }), getObjectText: async () => 'body' };
    const commits = { lock: vi.fn(async () => undefined), recordRevisions: vi.fn(async () => undefined) };
    const ingestion = { enqueue: vi.fn(async () => undefined) };
    const activity = { record: vi.fn(async () => undefined) };
    const svc = new DocumentsService(prisma, storage as never, _, ingestion as never, activity as never, _, _, _, _, _, _, _, _, _, _, commits as never);
    return { svc, committed, commits, ingestion, activity, branch };
  }

  it('a second finalize that read the draft before the first committed writes nothing', async () => {
    const r = rig('r1', ['r1'], 2);
    expect(await r.svc.finalizeRevision('d1', 'r2')).toMatchObject({ status: 'finalized', ingestionJobId: 'j1' });
    expect(await r.svc.finalizeRevision('d1', 'r2')).toMatchObject({ status: 'finalized', ingestionJobId: null, deduplicated: false });
    expect(r.committed.filter((k) => k === 'ingestionJob.create')).toHaveLength(1);
    expect(r.commits.recordRevisions).toHaveBeenCalledTimes(1);
    expect(r.ingestion.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a draft whose parent is no longer the head refuses with 409 and moves nothing', async () => {
    const r = rig('r9', ['r1']);
    await expect(r.svc.finalizeRevision('d1', 'r2')).rejects.toMatchObject({
      status: 409,
      response: { currentHeadRevisionId: 'r9', comparisonUrl: '/v1/documents/d1/compare?from=r1&to=r9&mode=merge-base' },
    });
    expect(r.committed).toEqual([]);
    expect(r.ingestion.enqueue).not.toHaveBeenCalled();
    expect(r.activity.record).not.toHaveBeenCalled();
  });

  it('a draft that has the head as any parent advances it (a push parents on its second parent alone)', async () => {
    const r = rig('r7', ['r7']);
    await r.svc.finalizeRevision('d1', 'r2', { commit: false, dedupe: false });
    expect(r.branch.headRevisionId).toBe('r2');
    expect(r.commits.recordRevisions).not.toHaveBeenCalled();
  });
});

describe('#811 one revision writer', () => {
  const doc = { id: 'd1', defaultBranch: 'main', archivedAt: null, projectId: 'p1', workspaceId: WS };

  it('writeRevision: a refused finalize leaves no draft behind', async () => {
    const { prisma, committed } = fakePrisma({});
    const storage = { putObjectText: vi.fn(async () => undefined) };
    const svc = stub(Object.create(DocumentsService.prototype) as DocumentsService, {
      prisma,
      storage,
      openDraft: async () => {
        await (prisma as { documentRevision: { create: (a: unknown) => Promise<unknown> } }).documentRevision.create({});
        return { id: 'r2', s3Key: 's', contentType: 'text/markdown' };
      },
      finalizeRevision: boom,
    });
    await expect(svc.writeRevision('d1', { text: 'md' })).rejects.toThrow('boom');
    expect(storage.putObjectText).toHaveBeenCalledWith('s', 'md', 'text/markdown');
    expect(committed).toEqual([]);
  });

  it('writeRevision: a moved head is the 409 with its comparison link', async () => {
    const { prisma, committed } = fakePrisma({ 'document.findUnique': doc, 'documentBranch.findUnique': { headRevisionId: 'r9' } });
    const svc = stub(Object.create(DocumentsService.prototype) as DocumentsService, { prisma });
    const err = await svc.writeRevision('d1', { text: 'md', expectedHeadRevisionId: 'r1' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409 });
    expect((err as { getResponse: () => unknown }).getResponse()).toMatchObject({
      currentHeadRevisionId: 'r9',
      comparisonUrl: '/v1/documents/d1/compare?from=r1&to=r9&mode=merge-base',
    });
    expect(committed).toEqual([]);
  });

  it('MCP knowledge_create_revision hands its base revision to writeRevision', async () => {
    const { prisma } = fakePrisma({ 'document.findUnique': { ...doc, kind: 'page' } });
    const documents = {
      getContent: vi.fn(async () => ({ frontmatter: { tags: ['x'] } })),
      writeRevision: vi.fn(async () => ({ revisionId: 'r2', status: 'finalized' })),
    };
    const svc = stub(Object.create(McpService.prototype) as McpService, { prisma, documents });
    const create = (svc as unknown as { createRevision: (...a: unknown[]) => Promise<unknown> }).createRevision.bind(svc);
    await create('d1', { baseRevisionId: 'r1', content: '# Body' }, 'u1');
    expect(documents.getContent).toHaveBeenCalledWith('d1', 'r1');
    expect(documents.writeRevision).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ expectedHeadRevisionId: 'r1', branch: 'main', text: expect.stringContaining('# Body') }),
      'u1',
    );
  });

  it('assistant propose_update: a refused merge request leaves no branch and no revision', async () => {
    const { prisma, committed } = fakePrisma({});
    const write = (model: string) => (prisma as Record<string, { create: (a: unknown) => Promise<unknown> }>)[model]!.create({});
    const documents = {
      getContent: vi.fn(async () => ({ frontmatter: {} })),
      createBranch: vi.fn(async () => write('documentBranch')),
      writeRevision: vi.fn(async () => (await write('documentRevision'), { revisionId: 'r2' })),
    };
    const svc = stub(Object.create(AssistantToolsService.prototype) as AssistantToolsService, {
      prisma,
      documents,
      mergeRequests: { create: boom },
      requireWorkspaceDocument: async () => ({ id: 'd1', title: 'Page' }),
    });
    const propose = (svc as unknown as { proposeUpdate: (...a: unknown[]) => Promise<{ ok: boolean }> }).proposeUpdate.bind(svc);
    const result = await propose({ documentId: 'd1', markdown: '# New', title: 'Fix' }, { principal: { userId: 'u1' } });
    expect(result.ok).toBe(false);
    expect(documents.writeRevision).toHaveBeenCalled();
    expect(committed).toEqual([]);
  });

  it('a finding\'s create page: a failed write-back leaves no page', async () => {
    const run = { id: 'run1', workspaceId: WS, agentKey: 'archaeologist', input: {}, findings: [{ kind: 'gap', title: 'T', detail: '', documentIds: [], draft: { title: 'New', markdown: '# New' } }] };
    const { prisma, committed } = fakePrisma({ 'agentRun.findUnique': run, 'project.findFirst': { id: 'p1' } });
    const documents = {
      createDocument: vi.fn(async () => {
        await (prisma as { document: { create: (a: unknown) => Promise<unknown> } }).document.create({});
        return { documentId: 'new-doc' };
      }),
    };
    const svc = stub(Object.create(AgentFindingsService.prototype) as AgentFindingsService, {
      prisma,
      documents,
      logger: { warn: vi.fn() },
      writeBackPage: boom,
    });
    await expect(svc.createPage(WS, 'run1', 0, { userId: 'u1' } as never)).rejects.toThrow('boom');
    expect(documents.createDocument).toHaveBeenCalled();
    // The claim and its release commit on their own; the page does not.
    expect(committed).toEqual(['$executeRaw', '$executeRaw']);
  });
});
