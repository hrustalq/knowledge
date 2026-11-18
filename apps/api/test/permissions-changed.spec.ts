import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { firstValueFrom, take, toArray } from 'rxjs';
import type { KnowledgeEvent } from '@knowledge/contracts';
import { AclEventsService } from '../src/permissions/acl-events.service.js';
import { EventsSubscriber } from '../src/events/events.subscriber.js';
import { UsersService } from '../src/users/users.service.js';
import { drainAfterCommit, runInTransaction } from '../src/prisma/transaction.js';

/**
 * permissions.changed (#1297). What is pinned here:
 * - one frame per person, carrying the type, the workspace and their userId and nothing else;
 * - published after the outermost commit, never before;
 * - the SSE stream hands an addressed frame to its person and nobody else;
 * - the platform-admin flag tells every workspace the person belongs to.
 * Which writers call it is pinned in role-sync.spec.ts.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function publisher() {
  const publish = vi.fn(async (_e: unknown) => undefined);
  return { publish, service: new AclEventsService({ publish } as never, {} as never) };
}

describe('AclEventsService.permissionsChanged', () => {
  it('publishes one addressed frame per distinct person, carrying nothing about the change', async () => {
    const { publish, service } = publisher();
    service.permissionsChanged(WS, [ADA, BOB, ADA]);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(publish.mock.calls.map((c) => c[0])).toEqual([
      { type: 'permissions.changed', workspaceId: WS, userId: ADA },
      { type: 'permissions.changed', workspaceId: WS, userId: BOB },
    ]);
    service.permissionsChanged(WS, []);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('waits for the outermost commit', async () => {
    const { publish, service } = publisher();
    const [, scope] = await runInTransaction({} as never, async () => {
      service.permissionsChanged(WS, [ADA]);
    });
    expect(publish).not.toHaveBeenCalled();
    await drainAfterCommit(scope);
    expect(publish).toHaveBeenCalledOnce();
  });
});

describe('EventsSubscriber.stream', () => {
  it('delivers a permissions.changed frame to the person it names and to nobody else', async () => {
    const subscriber = new EventsSubscriber({ get: () => 'redis://127.0.0.1:1' } as never);
    const listen = (userId: string) =>
      firstValueFrom(subscriber.stream(WS, { userId } as never, async () => true).pipe(take(2), toArray()));
    const ada = listen(ADA);
    const bob = listen(BOB);
    const frame = (userId: string): KnowledgeEvent => ({ type: 'permissions.changed', workspaceId: WS, userId, at: '' });
    const bus = (subscriber as unknown as { subject: { next(e: KnowledgeEvent): void } }).subject;
    bus.next(frame(ADA));
    bus.next({ ...frame(BOB), workspaceId: OTHER });
    bus.next(frame(BOB));
    bus.next({ type: 'acl.changed', workspaceId: WS, at: '' });
    expect((await ada).map((m) => [m.data.type, m.data.userId])).toEqual([
      ['permissions.changed', ADA],
      ['acl.changed', undefined],
    ]);
    expect((await bob).map((m) => [m.data.type, m.data.userId])).toEqual([
      ['permissions.changed', BOB],
      ['acl.changed', undefined],
    ]);
    subscriber.onModuleDestroy();
  });
});

describe('UsersService.update', () => {
  function users(isAdmin: boolean) {
    const permissionsChanged = vi.fn();
    const row = { id: ADA, isAdmin, displayName: 'Ada', disabledAt: null, memberships: [{ workspaceId: WS }, { workspaceId: OTHER }] };
    const prisma = {
      user: { findUnique: vi.fn(async () => row), update: vi.fn(async ({ data }: { data: object }) => ({ ...row, ...data })) },
      session: { findFirst: vi.fn(async () => null) },
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
    };
    const service = new UsersService(prisma as never, {} as never, {} as never, {} as never, { record: vi.fn() } as never, { permissionsChanged } as never);
    Object.assign(service, { toSummary: () => ({}) });
    return { service, permissionsChanged };
  }

  it('a platform-admin flip tells every workspace the person belongs to; anything else tells none', async () => {
    const flipped = users(true);
    await flipped.service.update({ userId: BOB } as never, ADA, { isAdmin: false });
    expect(flipped.permissionsChanged.mock.calls).toEqual([
      [WS, [ADA]],
      [OTHER, [ADA]],
    ]);

    const same = users(true);
    await same.service.update({ userId: BOB } as never, ADA, { isAdmin: true, displayName: 'Ada L.' });
    expect(same.permissionsChanged).not.toHaveBeenCalled();
  });
});
