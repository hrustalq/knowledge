import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
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

function fakePrisma() {
  return {
    aiAgent: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    agentTrigger: { findMany: vi.fn().mockResolvedValue([]) },
    project: { count: vi.fn().mockResolvedValue(1) },
    connector: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
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

function configurator(prisma: ReturnType<typeof fakePrisma>, runWithTools: unknown) {
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
    config as never,
  );
}

describe('configurator tool loop (#1250)', () => {
  it('answers only its own tools, and its one write is the proposal row', async () => {
    const prisma = fakePrisma();
    const results: string[] = [];
    const runWithTools = vi.fn(async (_ctx, _messages, tools: Array<{ function: { name: string } }>, execute) => {
      expect(tools.map((t) => t.function.name)).toEqual(['list_agents', 'list_agent_triggers', 'list_projects', 'list_connectors', 'propose_configuration']);
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
      configuratorSvc as never,
    );

    await expect(svc.apply('p1', WS, ['c1'], principal)).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.requireRole).toHaveBeenCalledWith(principal, WS, 'admin');
    expect(prisma.withTransaction).not.toHaveBeenCalled();
    expect(triggers.create).not.toHaveBeenCalled();
  });
});
