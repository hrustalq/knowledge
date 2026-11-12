import { describe, expect, it, vi } from 'vitest';
import { WorkItemRulesService } from '../src/connectors/handoff/work-item-rules.service.js';

/**
 * Handoff rules per project (#923). The effective rule is resolved in the
 * candidate SQL, which `work-item-handoff.e2e-spec.ts` runs against Postgres;
 * this pins which workspaces and kinds a tick looks at, and that an issue is
 * admitted by its own project's rule.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function harness(opts: {
  workspaces?: Array<Record<string, unknown>>;
  projects?: Array<Record<string, unknown>>;
  issues?: Array<{ id: string; kind: string; report_count: number; rule: string }>;
}) {
  const sql: string[] = [];
  const prisma = {
    workspaceSettings: { findMany: vi.fn(async () => opts.workspaces ?? []) },
    project: { findMany: vi.fn(async () => opts.projects ?? []) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      sql.push(text);
      return text.includes('FROM knowledge_issues') ? (opts.issues ?? []) : [];
    }),
  };
  const anchors = { describe: vi.fn(async (_ws: string, kind: string, id: string) => ({ kind, id })) };
  const handoffs = { handoffByRule: vi.fn(async () => ({})) };
  const config = { get: (key: string) => (key === 'WORK_ITEM_AUTOCREATE_MAX_PER_TICK' ? 10 : true) };
  return { svc: new WorkItemRulesService(prisma as never, anchors as never, handoffs as never, config as never), prisma, anchors, sql };
}

const NO_RULES = { workItemIssues: null, workItemConflicts: null, workItemVerification: null };

describe('WorkItemRulesService.autoCreate with project rules', () => {
  it('looks at nothing while no workspace and no project has a rule', async () => {
    const { svc, prisma } = harness({});
    expect(await svc.autoCreate()).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('with no project values, queries exactly the kinds the workspace turned on', async () => {
    const { svc, sql } = harness({ workspaces: [{ workspaceId: WS, ...NO_RULES, workItemConflicts: 'on' }] });
    await svc.autoCreate();
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('FROM knowledge_conflicts');
    expect(sql[0]).toContain("COALESCE(p.work_item_conflicts, ?) = 'on'");
  });

  it('visits a workspace whose only rule is on a project, for that kind alone', async () => {
    const { svc, sql, prisma } = harness({ projects: [{ workspaceId: OTHER, ...NO_RULES, workItemVerification: 'outdated' }] });
    await svc.autoCreate();
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('FROM documents d');
    // The rule is a nested fragment: COALESCE(project's, workspace's), the workspace's going in as `off`.
    expect(sql[0]).toContain("d.verification_flag = 'requested' AND ? = 'all'");
    const rule = prisma.$queryRaw.mock.calls[0]!.find((v) => (v as { sql?: string })?.sql?.includes('COALESCE')) as unknown as { sql: string; values: unknown[] };
    expect(rule.sql).toBe('COALESCE(p.work_item_verification, ?)');
    expect(rule.values).toEqual(['off']);
  });

  it("admits an issue by its own project's rule, not the workspace's", async () => {
    const { svc, anchors, sql } = harness({
      workspaces: [{ workspaceId: WS, ...NO_RULES, workItemIssues: 'all' }],
      issues: [
        { id: 'low-in-all', kind: 'unclear', report_count: 1, rule: 'all' },
        { id: 'low-in-high', kind: 'unclear', report_count: 1, rule: 'high' },
        { id: 'wrong-in-high', kind: 'wrong', report_count: 1, rule: 'high' },
      ],
    });
    expect(await svc.autoCreate()).toBe(2);
    expect(anchors.describe.mock.calls.map((c) => c[2])).toEqual(['low-in-all', 'wrong-in-high']);
    expect(sql[0]).toContain("AND ? <> 'off'");
  });
});
