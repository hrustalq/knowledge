import { describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigurationChange } from '@knowledge/contracts';
import { readChanges } from '../src/configurator/configuration-changes.js';
import { ConfiguratorService } from '../src/configurator/configurator.service.js';
import { ConfigurationApplyService } from '../src/configurator/configuration-apply.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const principal = { userId: 'u1', locale: 'en', mode: 'session' } as never;

describe('configurator change parse (#1250)', () => {
  it('narrows each kind, fills the person\'s zone, and drops what could never be switched on', () => {
    const { changes, dropped } = readChanges(
      [
        { kind: 'agent-schedule', agentKey: 'digest', scheduleKind: 'weekly', scheduleTime: '09:00', scheduleWeekdays: [1, 1], scheduleMinutes: 60, reason: 'Mondays' },
        { kind: 'agent-schedule', agentKey: 'digest', scheduleKind: 'weekly', scheduleTime: '09:00', reason: 'no days' },
        { kind: 'agent-trigger', agentKey: 'reviewer', event: 'page.merged', projectId: PROJECT, reason: 'review merges' },
        { kind: 'set-env', reason: 'nope' },
      ],
      'Europe/Moscow',
    );
    expect(changes.map((c) => c.spec)).toEqual([
      // Only the fields a weekly schedule reads; the stray interval is gone.
      { kind: 'agent-schedule', agentKey: 'digest', scheduleKind: 'weekly', scheduleMinutes: null, scheduleTime: '09:00', scheduleWeekdays: [1], scheduleTimezone: 'Europe/Moscow', scheduleNote: null },
      { kind: 'agent-trigger', agentKey: 'reviewer', event: 'page.merged', projectId: PROJECT, filter: {}, note: null },
    ]);
    expect(dropped.map((d) => d.index)).toEqual([1, 3]);
    expect(dropped[1]!.error).toMatch(/kind must be one of/);
  });
});

/** "When a use-case page is merged, draft its test cases" — the AC of #1312, as the model would send it. */
const TEST_CASES = {
  kind: 'workflow-draft',
  name: 'Test cases from use cases',
  description: 'Drafts test cases for every merged use case.',
  steps: [
    { id: 'List cases', kind: 'ai.generate', title: 'List test cases', prompt: 'List the test cases this use case needs.', next: ['draft'], fanOut: true, maxItems: 10 },
    { id: 'draft', kind: 'ai.draft', title: 'Draft a test case', prompt: 'Write the test case.', next: ['review'], produces: { category: 'reference', relationToParent: 'NOPE' } },
    { id: 'review', kind: 'review', title: 'Review', next: [] },
    { id: 'ghost', kind: 'deploy', title: 'Not a kind' },
  ],
  autoStart: true,
  events: ['revision.indexed'],
  categories: ['use-case'],
  reason: 'the goal',
};

describe('configurator workflow drafts and templates (#1312)', () => {
  it('narrows a workflow through the architect\'s reader and compiles it before offering it', () => {
    const cycle = {
      ...TEST_CASES,
      steps: [
        { id: 'a', kind: 'ai.draft', title: 'A', next: ['b'] },
        { id: 'b', kind: 'ai.draft', title: 'B', next: ['a'] },
      ],
    };
    const { changes, dropped } = readChanges(
      [
        TEST_CASES,
        cycle,
        { kind: 'page-template', name: 'Test case', source: '---\ntemplate:\n  category: reference\n---\n# {{title}}\n', reason: 'r' },
        { kind: 'page-template', name: 'Broken', source: '---\n: : :\n---\nbody', reason: 'r' },
      ],
      null,
    );
    const workflow = changes[0]!.spec;
    expect(workflow).toMatchObject({
      kind: 'workflow-draft',
      projectId: null,
      trigger: { manual: true, autoStart: true, events: ['revision.indexed'], categories: ['use-case'] },
    });
    if (workflow.kind !== 'workflow-draft') throw new Error('kind');
    // The unknown kind is gone, the id is slugged, the made-up edge type falls back.
    expect(workflow.graph.steps.map((st) => st.id)).toEqual(['list-cases', 'draft', 'review']);
    expect(workflow.graph.steps[1]!.produces?.relationToParent).toBe('IMPLEMENTS');
    expect(workflow.graph.steps.every((st) => st.autoApprove === false)).toBe(true);
    expect(changes[1]!.spec).toMatchObject({ kind: 'page-template', name: 'Test case', projectId: null });
    expect(dropped.map((d) => d.index)).toEqual([1, 3]);
    expect(dropped[0]!.error).toMatch(/^steps/);
    expect(dropped[1]!.error).toMatch(/^source/);
  });

  it('asks the templates route\'s role, and nothing at all while the workflows section is off', async () => {
    const prisma = fakePrisma();
    const svc = configurator(prisma, vi.fn(), { disabled: ['workflows'] });
    const project = { kind: 'page-template', name: 'T', description: null, projectId: PROJECT, source: '# t' } as const;
    const [wf, inProject, wide] = await svc.assess(WS, [
      readChanges([TEST_CASES], null).changes[0]!,
      { spec: project, reason: '' },
      { spec: { ...project, projectId: null }, reason: '' },
    ]);
    expect(wf).toMatchObject({ requires: 'admin', unavailable: 'section-off' });
    expect(inProject).toMatchObject({ requires: 'editor', unavailable: 'section-off' });
    expect(wide!.requires).toBe('admin');

    const on = configurator(fakePrisma(), vi.fn(), { taken: true });
    const [again] = await on.assess(WS, [{ spec: project, reason: '' }]);
    expect(again).toMatchObject({ state: 'unavailable', unavailable: 'name-taken' });
  });
});

function fakePrisma() {
  return {
    aiAgent: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    agentTrigger: { findMany: vi.fn().mockResolvedValue([]) },
    project: { count: vi.fn().mockResolvedValue(1) },
    connector: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
    workflowDefinition: { count: vi.fn().mockResolvedValue(0) },
    configurationProposal: {
      row: null as Record<string, unknown> | null,
      create: vi.fn(async function (this: { row: unknown }, { data }) {
        return (this.row = { id: 'p1', summary: '', createdAt: new Date(), updatedAt: new Date(), ...data });
      }),
      update: vi.fn(async function (this: { row: Record<string, unknown> }, { data }) {
        return (this.row = { ...this.row, ...data });
      }),
    },
  };
}

function configurator(
  prisma: ReturnType<typeof fakePrisma>,
  runWithTools: unknown,
  opts: { disabled?: string[]; taken?: boolean } = {},
) {
  const agents = {
    resolve: vi.fn(async (_ws: string, key: string) => ({ key, name: key, enabled: true, config: { enabled: true }, missing: [], instructions: 'x' })),
    list: vi.fn().mockResolvedValue([]),
  };
  const config = { get: vi.fn().mockReturnValue(true) };
  return new ConfiguratorService(
    prisma as never,
    agents as never,
    { assertWithinBudget: vi.fn() } as never,
    { runWithTools } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { disabled: vi.fn().mockResolvedValue(opts.disabled ?? []) } as never,
    {
      assertNameFree: vi.fn(async () => {
        if (opts.taken) throw new ConflictException('taken');
      }),
      resolve: vi.fn().mockResolvedValue({ row: null }),
    } as never,
    config as never,
  );
}

describe('configurator tool loop (#1250)', () => {
  it('answers only its own tools, and its one write is the proposal row', async () => {
    const prisma = fakePrisma();
    const results: string[] = [];
    const runWithTools = vi.fn(async (_ctx, _messages, tools: Array<{ function: { name: string } }>, execute) => {
      expect(tools.map((t) => t.function.name)).toEqual(['list_agents', 'list_agent_triggers', 'list_projects', 'list_connectors', 'list_workflows', 'list_templates', 'propose_configuration']);
      // A name it was never offered is refused on execution, whatever the model asks.
      results.push((await execute('update_agent', {})).content);
      results.push(
        (await execute('propose_configuration', {
          changes: [{ kind: 'agent-schedule', agentKey: 'digest', scheduleKind: 'daily', scheduleTime: '09:00', reason: 'daily digest' }],
        })).content,
      );
      return { content: 'Proposed a daily digest.' };
    });
    const res = await configurator(prisma, runWithTools).propose(WS, 'digest every day', null, principal);

    expect(results[0]).toContain('Unknown tool update_agent');
    expect(JSON.parse(results[1]!).accepted).toEqual([{ kind: 'agent-schedule', target: 'digest', unavailable: null }]);
    expect(prisma.configurationProposal.create).toHaveBeenCalledTimes(1);
    expect(res.reply).toBe('Proposed a daily digest.');
    expect(res.proposal?.changes[0]).toMatchObject({ id: 'c1', state: 'pending', requires: 'admin' });
  });

  it('marks a change the workspace already has, and one the server switches off, as unavailable', async () => {
    const prisma = fakePrisma();
    prisma.aiAgent.findUnique.mockResolvedValue({ scheduleKind: 'daily', scheduleMinutes: null, scheduleTime: '09:00', scheduleWeekdays: null, scheduleTimezone: null, scheduleNote: null });
    const svc = configurator(prisma, vi.fn());
    const [same, trigger] = await svc.assess(WS, [
      { spec: { kind: 'agent-schedule', agentKey: 'digest', scheduleKind: 'daily', scheduleMinutes: null, scheduleTime: '09:00', scheduleWeekdays: null, scheduleTimezone: null, scheduleNote: null }, reason: '' },
      // The sentinel is not triggerable: its PR check is the connector's drift check.
      { spec: { kind: 'agent-trigger', agentKey: 'sentinel', event: 'page.merged', projectId: null, filter: {}, note: null }, reason: '' },
    ]);
    expect(same!.unavailable).toBe('already-configured');
    expect(trigger!.unavailable).toBe('agent-unsupported');
  });
});

describe('configuration apply (#1250)', () => {
  it('refuses an editor a workspace-level change before writing anything', async () => {
    const pending: ConfigurationChange = {
      id: 'c1',
      spec: { kind: 'agent-trigger', agentKey: 'reviewer', event: 'page.merged', projectId: null, filter: {}, note: null },
      reason: '',
      target: 'Reviewer',
      diff: [],
      state: 'pending',
      unavailable: null,
      requires: 'admin',
      appliedAt: null,
      appliedBy: null,
      resultId: null,
    };
    const prisma = { withTransaction: vi.fn() };
    const triggers = { create: vi.fn() };
    const access = { requireRole: vi.fn().mockRejectedValue(new ForbiddenException('admin required')) };
    const configuratorSvc = { require: vi.fn().mockResolvedValue({ id: 'p1', changes: [pending] }) };
    const svc = new ConfigurationApplyService(
      prisma as never,
      access as never,
      {} as never,
      {} as never,
      {} as never,
      triggers as never,
      {} as never,
      {} as never,
      {} as never,
      configuratorSvc as never,
    );

    await expect(svc.apply('p1', WS, ['c1'], principal)).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.requireRole).toHaveBeenCalledWith(principal, WS, 'admin');
    expect(prisma.withTransaction).not.toHaveBeenCalled();
    expect(triggers.create).not.toHaveBeenCalled();
  });
});

describe('configuration apply, workflow drafts and templates (#1312)', () => {
  function change(spec: ConfigurationChange['spec'], requires: ConfigurationChange['requires']): ConfigurationChange {
    return { id: 'c1', spec, reason: '', target: 'x', diff: [], state: 'pending', unavailable: null, requires, appliedAt: null, appliedBy: null, resultId: null };
  }

  function applier(pending: ConfigurationChange) {
    const row = { id: 'p1', workspaceId: WS, goal: 'g', summary: '', createdBy: 'u1', createdAt: new Date(), updatedAt: new Date(), changes: [pending] };
    const prisma = {
      withTransaction: vi.fn((fn: () => unknown) => fn()),
      $executeRaw: vi.fn(),
      configurationProposal: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(row),
        update: vi.fn(async ({ data }) => ({ ...row, ...data })),
      },
    };
    const access = { requireRole: vi.fn() };
    const workflows = { create: vi.fn().mockResolvedValue({ id: 'wf1' }) };
    const templates = { create: vi.fn().mockResolvedValue({ id: 'tpl1', ref: 'tpl1' }) };
    const configuratorSvc = {
      require: vi.fn().mockResolvedValue(row),
      assess: vi.fn(async (_ws: string, items: Array<{ spec: unknown }>) => items.map((i) => ({ spec: i.spec, diff: [], unavailable: null }))),
    };
    const svc = new ConfigurationApplyService(
      prisma as never,
      access as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      workflows as never,
      templates as never,
      configuratorSvc as never,
    );
    return { svc, access, workflows, templates };
  }

  it('creates the workflow disabled, as an admin', async () => {
    const spec = readChanges([TEST_CASES], null).changes[0]!.spec;
    const { svc, access, workflows } = applier(change(spec, 'admin'));
    const res = await svc.apply('p1', WS, ['c1'], principal);
    expect(access.requireRole).toHaveBeenCalledWith(principal, WS, 'admin');
    expect(workflows.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, enabled: false, name: 'Test cases from use cases' }), 'u1');
    expect(res.changes[0]).toMatchObject({ state: 'applied', resultId: 'wf1' });
  });

  it('takes the role from the spec, not the stored row: a workspace-wide template needs admin', async () => {
    const wide = { kind: 'page-template', name: 'T', description: null, projectId: null, source: '# t' } as const;
    // A row claiming editor for a workspace-wide template is still asked admin.
    const { svc, access, templates } = applier(change(wide, 'editor'));
    await svc.apply('p1', WS, ['c1'], principal);
    expect(access.requireRole).toHaveBeenCalledWith(principal, WS, 'admin');
    expect(templates.create).toHaveBeenCalledWith({ workspaceId: WS, projectId: null, name: 'T', description: null, source: '# t' }, 'u1');

    const inProject = applier(change({ ...wide, projectId: PROJECT }, 'editor'));
    await inProject.svc.apply('p1', WS, ['c1'], principal);
    expect(inProject.access.requireRole).toHaveBeenCalledWith(principal, WS, 'editor');
  });
});
