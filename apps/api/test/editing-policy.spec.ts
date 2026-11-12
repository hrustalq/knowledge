import { describe, expect, it, vi } from 'vitest';
import { EditingPolicyService } from '../src/auth/editing-policy.service.js';

const WS = '11111111-1111-4111-8111-111111111111';

export function editingPolicy(row: Record<string, unknown> | null, envApprovals = 1) {
  let stored = row;
  const prisma = {
    workspaceSettings: {
      findUnique: vi.fn(async () => stored),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => void (stored = { ...stored, ...update })),
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  return { prisma, audit, editing: new EditingPolicyService(prisma as never, { get: () => envApprovals } as never, audit as never) };
}

const effective = async (row: Record<string, unknown> | null, env = 1) => {
  const p = await editingPolicy(row, env).editing.policy(WS);
  return [p.publishMode.effective, p.historyAudience.effective, p.requiredApprovals.effective];
};

describe('editing policy (#958)', () => {
  it('an empty row is review, everyone and the env approvals, with nothing asked', async () => {
    const p = await editingPolicy(null, 3).editing.policy(WS);
    expect(p.publishMode).toMatchObject({ workspace: null, effective: 'review', source: 'default' });
    expect(p.historyAudience).toMatchObject({ workspace: null, effective: 'everyone', source: 'default' });
    expect(p.requiredApprovals).toMatchObject({ workspace: null, effective: 3, source: 'default' });
  });

  it('each column overrides alone, 0 approvals included, and an unknown stored value reads as unset', async () => {
    expect(await effective({ publishMode: 'direct' })).toEqual(['direct', 'everyone', 1]);
    expect(await effective({ historyAudience: 'editors' })).toEqual(['review', 'editors', 1]);
    expect(await effective({ requiredApprovals: 0 })).toEqual(['review', 'everyone', 0]);
    expect(await effective({ requiredApprovals: 2 })).toEqual(['review', 'everyone', 2]);
    expect(await effective({ publishMode: 'yolo' })).toEqual(['review', 'everyone', 1]);
  });

  it('a write drops the cache, leaves omitted keys alone, takes null back to inheriting and is audited', async () => {
    const { prisma, audit, editing } = editingPolicy({ requiredApprovals: 2 });
    await editing.policy(WS);
    const saved = await editing.set(WS, { publishMode: 'direct' }, 'u1');
    expect(saved.publishMode.effective).toBe('direct');
    expect(saved.requiredApprovals.effective).toBe(2);
    expect(prisma.workspaceSettings.upsert.mock.calls[0]![0].update).toEqual({ publishMode: 'direct', updatedBy: 'u1' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'workspace.editing_policy_updated', params: { publishMode: 'direct' } }));
    expect((await editing.set(WS, { requiredApprovals: null }, 'u1')).requiredApprovals).toMatchObject({ workspace: null, effective: 1 });
  });
});
