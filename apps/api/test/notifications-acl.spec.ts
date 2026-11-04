import { describe, expect, it, vi } from 'vitest';
import { ACCESS_META } from '../src/auth/access.decorator.js';
import { NotificationsController } from '../src/notifications/notifications.controller.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';

/**
 * Notifications follow page visibility (issue #76, phase 5).
 *
 * What is pinned:
 * 1. **A row reaches only people who can open its page**, however they came to
 *    watch it. A guest with a grant is told; a guest or member the chain keeps
 *    out is not.
 * 2. **A mention of someone who cannot open the page notifies nobody** and names
 *    them in `mentionedWithoutAccess`, so the author can grant or ask.
 * 3. **`requireAccess: false`** — the answer to someone's own access request —
 *    reaches them even though they cannot open the page.
 * 4. **An event about no page** still reaches members, not guests.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';
const ALICE = '44444444-4444-4444-8444-444444444444'; // member, granted
const BOB = '55555555-5555-4555-8555-555555555555'; // guest, not granted
const CAROL = '66666666-6666-4666-8666-666666666666'; // guest, granted
const DAN = '77777777-7777-4777-8777-777777777777'; // member, not granted
const ACTOR = '88888888-8888-4888-8888-888888888888';

const ROLES: Record<string, string> = { [ALICE]: 'viewer', [BOB]: 'guest', [CAROL]: 'guest', [DAN]: 'editor' };

/** PAGE is restricted to ALICE and CAROL; the project is open. */
function fakePrisma() {
  return {
    project: { findUnique: vi.fn(async () => ({ workspaceId: WS, name: 'Ops', restricted: false })) },
    document: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === PAGE ? { workspaceId: WS, projectId: PROJECT, path: `/${PAGE}/` } : null,
      ),
      findMany: vi.fn(async () => [{ id: PAGE, title: 'Incident review', restricted: true }]),
    },
    accessGrant: {
      findMany: vi.fn(async () => [
        { resourceId: PAGE, subjectType: 'user', subjectId: ALICE, level: 'view' },
        { resourceId: PAGE, subjectType: 'user', subjectId: CAROL, level: 'view' },
      ]),
    },
    workspaceMember: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] }; role?: unknown } }) =>
        where.userId.in
          .filter((id) => ROLES[id] && (where.role === undefined || ROLES[id] === where.role))
          .map((userId) => ({ userId, role: ROLES[userId], user: { isAdmin: false } })),
      ),
    },
    userGroupMember: { findMany: vi.fn(async () => []) },
    notificationPreference: { findMany: vi.fn(async () => []) },
    notificationSubscription: { findUnique: vi.fn(async () => ({ id: 'sub' })), create: vi.fn() },
  };
}

function serviceOver(prisma: ReturnType<typeof fakePrisma>) {
  const service = new NotificationsService(prisma as never);
  vi.spyOn(service as unknown as { write: (i: { userId: string }) => Promise<unknown> }, 'write').mockImplementation(
    async (input) => ({ id: input.userId }),
  );
  return service;
}

function deliverOf(service: NotificationsService) {
  return (service as unknown as { deliver: (...a: unknown[]) => Promise<{ userId: string }[]> }).deliver.bind(service);
}

const everyone = () =>
  new Map([
    [ALICE, 'watching'],
    [BOB, 'watching'],
    [CAROL, 'watching'],
    [DAN, 'watching'],
  ]);

describe('notification delivery under page restrictions', () => {
  it('reaches only those who can open the page — a granted guest included', async () => {
    const deliveries = await deliverOf(serviceOver(fakePrisma()))(
      { type: 'revision.finalized', workspaceId: WS, documentId: PAGE, title: 'Incident review', actor: ACTOR },
      'document',
      everyone(),
      { workspaceId: WS, subjectType: 'document', subjectId: PAGE },
    );
    expect(deliveries.map((d) => d.userId).sort()).toEqual([ALICE, CAROL].sort());
  });

  it('tells nobody about a page that no longer exists', async () => {
    const deliveries = await deliverOf(serviceOver(fakePrisma()))(
      { type: 'document.updated', workspaceId: WS, documentId: '99999999-9999-4999-8999-999999999999', actor: ACTOR },
      'document',
      everyone(),
      { workspaceId: WS, subjectType: 'document', subjectId: '99999999-9999-4999-8999-999999999999' },
    );
    expect(deliveries).toEqual([]);
  });

  it('delivers an answer to someone’s own request although they cannot open the page', async () => {
    const deliveries = await deliverOf(serviceOver(fakePrisma()))(
      { type: 'access.denied', workspaceId: WS, documentId: PAGE, actor: ACTOR },
      'access',
      new Map([[DAN, 'participant']]),
      { workspaceId: WS, subjectType: null, subjectId: null },
      undefined,
      false,
    );
    expect(deliveries.map((d) => d.userId)).toEqual([DAN]);
  });

  it('still keeps guests out of an event about no page', async () => {
    const deliveries = await deliverOf(serviceOver(fakePrisma()))(
      { type: 'export.completed', workspaceId: WS, actor: ACTOR },
      'job',
      everyone(),
      { workspaceId: WS, subjectType: null, subjectId: null },
    );
    expect(deliveries.map((d) => d.userId).sort()).toEqual([ALICE, DAN].sort());
  });
});

describe('mentions under page restrictions', () => {
  it('notifies the readers and names the members who cannot open the page', async () => {
    const result = await serviceOver(fakePrisma()).notifyMentions({
      workspaceId: WS,
      body: 'see this',
      userIds: [ALICE, BOB, DAN, ACTOR],
      type: 'document.comment.created',
      actor: ACTOR,
      documentId: PAGE,
      subjectType: 'document',
      subjectId: PAGE,
      title: 'Incident review',
    });
    expect(result.deliveries.map((d) => d.userId)).toEqual([ALICE]);
    // ACTOR is no member of the workspace: a stranger's id earns no answer.
    expect(result.mentionedWithoutAccess.sort()).toEqual([BOB, DAN].sort());
  });
});

describe('subscriptions under page restrictions (#773)', () => {
  const scope = (denied: string[]) =>
    ({ workspaceId: WS, userId: DAN, role: 'editor', bypass: false, guest: false, readOnly: false, groupIds: new Set(), denied: new Set(denied), granted: new Set() }) as never;
  const row = (subjectType: string, subjectId: string) => ({ id: subjectId, subjectType, subjectId, muted: false, reason: 'manual', createdAt: new Date(0) });
  const MR = '99999999-9999-4999-8999-999999999999';
  const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function service() {
    const restricted = { projectId: PROJECT, path: `/${PAGE}/`, restrictedBy: [PAGE] };
    const prisma = {
      notificationSubscription: {
        findMany: vi.fn(async () => [row('document', PAGE), row('merge-request', MR), row('project', OTHER)]),
        upsert: vi.fn(async () => ({})),
      },
      document: { findUnique: vi.fn(async () => ({ workspaceId: WS })), findMany: vi.fn(async () => [{ id: PAGE, title: 'Secret page', ...restricted }]) },
      mergeRequest: {
        findMany: vi.fn(async () => [{ id: MR, title: 'Secret change', document: restricted }]),
        findUnique: vi.fn(async () => ({ document: { workspaceId: WS } })),
        findUniqueOrThrow: vi.fn(async () => ({ documentId: PAGE })),
      },
      project: { findMany: vi.fn(async () => [{ id: OTHER, name: 'Secret project', restricted: true }]) },
    };
    return { prisma, svc: new NotificationsService(prisma as never) };
  }

  it('names a subject only while the caller can open it', async () => {
    const { svc } = service();
    const hidden = await svc.listSubscriptions(scope([PAGE, OTHER]));
    expect(hidden.subscriptions.map((s) => s.title)).toEqual([null, null, null]);
    expect(hidden.subscriptions.map((s) => s.subjectId)).toEqual([PAGE, MR, OTHER]);
    const open = await svc.listSubscriptions(scope([]));
    expect(open.subscriptions.map((s) => s.title)).toEqual(['Secret page', 'Secret change', 'Secret project']);
  });

  it('still mutes a hidden subject, answering with no title', async () => {
    const { svc, prisma } = service();
    const out = await svc.setSubscription(scope([PAGE, OTHER]), 'document', PAGE, 'muted');
    expect(prisma.notificationSubscription.upsert).toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toMatch(/Secret/);
  });

  it('resolves a merge request to its page, the node the refusal is decided on', async () => {
    const { svc } = service();
    expect(await svc.subjectResource(WS, 'merge-request', MR)).toEqual({ type: 'document', id: PAGE });
    expect(await svc.subjectResource(WS, 'document', PAGE)).toEqual({ type: 'document', id: PAGE });
  });

  it('refuses to start watching what the caller cannot open, and lets them mute it (controller)', async () => {
    const { svc } = service();
    const refusal = new Error('refused');
    const permissions = { scopeFor: vi.fn(async () => scope([PAGE])), requireLevel: vi.fn(async () => { throw refusal; }) };
    const controller = new NotificationsController(svc, permissions as never);
    const dto = { workspaceId: WS, subjectType: 'document', subjectId: PAGE } as const;
    await expect(controller.setSubscription({ ...dto, state: 'watching' } as never, {} as never)).rejects.toBe(refusal);
    await expect(controller.setSubscription({ ...dto, state: 'muted' } as never, {} as never)).resolves.toBeDefined();
  });
});

describe('the inbox routes (#777)', () => {
  const spec = (name: keyof NotificationsController) =>
    Reflect.getMetadata(ACCESS_META, NotificationsController.prototype[name]) as { guests?: true };

  it('admit a guest, who is written notifications; subscriptions and preferences do not', () => {
    for (const route of ['list', 'unreadCount', 'markRead'] as const) expect(spec(route).guests).toBe(true);
    for (const route of ['listSubscriptions', 'setSubscription', 'preferences', 'updatePreferences'] as const) {
      expect(spec(route).guests).toBeUndefined();
    }
  });
});
