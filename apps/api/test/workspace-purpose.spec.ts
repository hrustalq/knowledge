import { describe, expect, it, vi } from 'vitest';
import { WORKSPACE_FEATURES, WORKSPACE_USES, WORKSPACE_USE_KEYS, reconcilePurpose, suggestedDisabled } from '@knowledge/contracts';
import { FeaturesService } from '../src/auth/features.service.js';

const WS = '11111111-1111-4111-8111-111111111111';

describe('workspace purpose (#934): the catalogue and its map', () => {
  it('names only sections that exist', () => {
    for (const use of WORKSPACE_USE_KEYS) for (const f of WORKSPACE_USES[use]) expect(WORKSPACE_FEATURES).toContain(f);
  });

  it('suggests nothing off without a use, and never a section every use needs', () => {
    expect(suggestedDisabled([])).toEqual([]);
    expect(suggestedDisabled(['meeting-notes'])).toEqual(['workflows', 'qa', 'analytics', 'conflicts', 'git', 'sources']);
    expect(suggestedDisabled([...WORKSPACE_USE_KEYS])).toEqual([]);
  });

  it('reconcile: a section still on the old suggestion follows the new one, one set by hand is kept and reported', () => {
    const current = [...suggestedDisabled(['meeting-notes']), 'memos'] as const;
    const next = reconcilePurpose(['meeting-notes'], ['meeting-notes', 'api-docs'], current);
    expect(next.disabled).toEqual(['workflows', 'analytics', 'memos', 'conflicts']);
    expect(next.kept).toEqual(['memos']);
  });

  it('reconcile: a first purpose leaves a hand-disabled section off, and clearing the uses switches nothing off', () => {
    expect(reconcilePurpose([], ['meeting-notes'], ['captures'])).toEqual({
      disabled: ['workflows', 'qa', 'analytics', 'captures', 'conflicts', 'git', 'sources'],
      kept: ['captures'],
    });
    expect(reconcilePurpose(['meeting-notes'], [], [...suggestedDisabled(['meeting-notes']), 'memos'])).toEqual({ disabled: ['memos'], kept: ['memos'] });
  });
});

describe('workspace purpose (#934): storage', () => {
  function service(row: Record<string, unknown> | null) {
    let stored = row;
    const prisma = {
      workspaceSettings: {
        findUnique: vi.fn(async () => stored),
        upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => void (stored = { ...stored, ...update })),
      },
    };
    return { prisma, features: new FeaturesService(prisma as never, { get: () => true } as never) };
  }

  it('reports a workspace with no row as not asked, with nothing off', async () => {
    expect(await service(null).features.state(WS)).toEqual({ disabled: [], uses: [], purposeAsked: false });
  });

  it('writes uses, description, the confirmed list and the asked stamp in one upsert, and drops the cache', async () => {
    const { prisma, features } = service(null);
    await features.state(WS); // warm the cache with "not asked"
    const disabled = suggestedDisabled(['meeting-notes']);
    const saved = await features.setPurpose(WS, { uses: ['meeting-notes'], description: '  Weekly syncs  ', disabled }, 'u1');
    expect(prisma.workspaceSettings.upsert).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({ uses: ['meeting-notes'], description: 'Weekly syncs', disabled, suggestedDisabled: disabled });
    expect(saved.askedAt).not.toBeNull();
    expect(await features.state(WS)).toEqual({ disabled, uses: ['meeting-notes'], purposeAsked: true });
  });

  it('Skip stamps the question and switches nothing off', async () => {
    const { features } = service(null);
    await features.setPurpose(WS, { uses: [], disabled: [] }, 'u1');
    expect(await features.state(WS)).toEqual({ disabled: [], uses: [], purposeAsked: true });
  });

  it('reads a use a later release dropped as nothing', async () => {
    expect((await service({ disabledFeatures: [], purposeUses: ['meeting-notes', 'gone'], purposeAskedAt: null }).features.state(WS)).uses).toEqual(['meeting-notes']);
  });
});
