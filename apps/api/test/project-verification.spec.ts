import { describe, expect, it, vi } from 'vitest';
import { isInactive } from '@knowledge/contracts';
import { VerificationPolicyService } from '../src/verification/verification-policy.service.js';
import { healthFilterSql, KnowledgeHealthService } from '../src/verification/knowledge-health.service.js';
import { VerificationSweeper } from '../src/verification/verification.sweeper.js';

/**
 * Freshness thresholds per project (#921): project → workspace → env, in the
 * resolver every code reader uses and in the two SQL twins (the health CTE and
 * the reminder sweep), which must spell the same order.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENV = { VERIFICATION_DEFAULT_REVIEW_DAYS: 90, VERIFICATION_REMIND_BEFORE_DAYS: 7, PAGE_INACTIVE_AFTER_DAYS: 180, EMPTY_PAGE_MAX_CHARS: 40 };
const NONE = { reviewIntervalDays: null, remindBeforeDays: null, inactiveAfterDays: null, emptyMaxChars: null };

function policyOver(projects: Array<Record<string, unknown>>, workspaceRow: Record<string, unknown> | null = null) {
  const prisma = {
    knowledgeHealthSettings: { findUnique: vi.fn(async () => workspaceRow) },
    project: {
      // The service asks only for projects with an override; the fake applies that filter.
      findMany: vi.fn(async () => projects.filter((p) => Object.entries(p).some(([k, v]) => k !== 'id' && k !== 'workspaceId' && v !== null))),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => projects.find((p) => p.id === where.id)),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(projects.find((p) => p.id === where.id)!, data),
      ),
    },
  };
  const cache = { wrap: (_ns: string, _key: string, load: () => Promise<unknown>) => load(), invalidate: vi.fn(async () => undefined) };
  const config = { get: (key: keyof typeof ENV) => ENV[key] };
  return { policy: new VerificationPolicyService(prisma as never, config as never, cache as never), prisma, cache };
}

describe('VerificationPolicyService.thresholds', () => {
  it('reproduces the workspace values for every project while no project overrides', async () => {
    const { policy } = policyOver([{ id: A, workspaceId: WS, ...NONE }], { reviewIntervalDays: 30 });
    const of = await policy.thresholds(WS);
    const workspace = { reviewIntervalDays: 30, remindBeforeDays: 7, inactiveAfterDays: 180, emptyMaxChars: 40 };
    expect(of(A)).toEqual(workspace);
    expect(of(B)).toEqual(workspace);
    expect(of(null)).toEqual(workspace);
  });

  it('makes the same idle page inactive in one project and not in its neighbour', async () => {
    const { policy } = policyOver([
      { id: A, workspaceId: WS, ...NONE, inactiveAfterDays: 30 },
      { id: B, workspaceId: WS, ...NONE },
    ]);
    const of = await policy.thresholds(WS);
    const now = new Date('2026-11-12T00:00:00Z');
    const idle = new Date(now.getTime() - 60 * 86_400_000);
    expect(isInactive(idle, of(A).inactiveAfterDays, now)).toBe(true);
    expect(isInactive(idle, of(B).inactiveAfterDays, now)).toBe(false);
    // An explicit 0 is a value, not "inherit": it turns the rule off for that project.
    const off = await policyOver([{ id: A, workspaceId: WS, ...NONE, inactiveAfterDays: 0 }]).policy.thresholds(WS);
    expect(off(A).inactiveAfterDays).toBe(0);
  });

  it('shows each level beside what applies, and clearing a value returns to the workspace one', async () => {
    const { policy, cache } = policyOver([{ id: A, workspaceId: WS, ...NONE, reviewIntervalDays: 14 }], { reviewIntervalDays: 30 });
    expect((await policy.projectSettings(A)).reviewIntervalDays).toEqual({ workspace: 30, project: 14, effective: 14, source: 'project' });
    expect((await policy.projectSettings(A)).remindBeforeDays).toEqual({ workspace: null, project: null, effective: 7, source: 'default' });
    const cleared = await policy.updateProject(A, { reviewIntervalDays: null });
    expect(cleared.reviewIntervalDays).toEqual({ workspace: 30, project: null, effective: 30, source: 'workspace' });
    expect(cache.invalidate).toHaveBeenCalledWith(WS, 'health-settings:projects');
    expect((await policy.thresholds(WS))(A).reviewIntervalDays).toBe(30);
  });

  it('writes only the four thresholds, whatever else a patch carries', async () => {
    const { policy, prisma } = policyOver([{ id: A, workspaceId: WS, ...NONE }]);
    await policy.updateProject(A, { emptyMaxChars: 10, trustRanking: false, restricted: true } as never);
    expect(prisma.project.update.mock.calls[0]![0].data).toEqual({ emptyMaxChars: 10 });
  });
});

describe('the SQL twins of thresholds()', () => {
  const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');

  it('the health rows carry project → workspace thresholds, and the filters read the row', async () => {
    const prisma = { $queryRaw: vi.fn(async (..._args: unknown[]) => []), connectorWorkItem: { findMany: vi.fn(async () => []) } };
    const settings = { reviewIntervalDays: 90, remindBeforeDays: 7, inactiveAfterDays: 180, emptyMaxChars: 40 };
    const svc = new KnowledgeHealthService(
      prisma as never,
      { effective: vi.fn(async () => settings) } as never,
      {} as never,
      { breadcrumbsFor: vi.fn(async () => new Map()) } as never,
      {} as never,
      { get: () => 90 } as never,
    );
    const scope = { workspaceId: WS, userId: 'u', role: 'editor', bypass: true, guest: false, readOnly: false, groupIds: new Set(), denied: new Set(), granted: new Set() };
    await svc.list(scope as never, { filter: 'inactive' });
    const flat = JSON.stringify(prisma.$queryRaw.mock.calls[0]);
    expect(flat).toContain('COALESCE(p.inactive_after_days, ');
    expect(flat).toContain('COALESCE(p.empty_max_chars, ');
    expect(flat).toContain('LEFT JOIN projects p ON p.id = d.project_id');
    const now = new Date();
    expect(healthFilterSql('inactive', now, now).sql).toContain('r.inactive_after_days > 0 AND r.last_activity_at <');
    expect(healthFilterSql('stale', now, now).sql).toContain('r.inactive_after_days');
    expect(healthFilterSql('empty', now, now).sql).toContain('r.body_chars <= r.empty_max_chars');
  });

  it("the reminder sweep reads the project's window before the workspace's, so 0 on a project silences only it", async () => {
    const prisma = { $queryRaw: vi.fn(async (..._args: unknown[]) => []) };
    const sweeper = new VerificationSweeper(prisma as never, {} as never, {} as never, { defaults: () => ({ remindBeforeDays: 7 }) } as never, {} as never, { get: () => true } as never);
    await sweeper.remind(new Date());
    expect(sqlOf(prisma.$queryRaw.mock.calls[0]!)).toContain('COALESCE(p.remind_before_days, COALESCE(s.remind_before_days, ?::int))');
  });
});
