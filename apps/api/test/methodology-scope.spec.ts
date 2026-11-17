import { describe, expect, it, vi } from 'vitest';
import { scopeWhere, shadowByScope } from '../src/projects/methodology-scope.js';
import { WorkflowsService } from '../src/workflows/workflows.service.js';

const row = (name: string, projectId: string | null, blueprintId: string | null) => ({ name, projectId, blueprintId });

describe('methodology scope (#1123)', () => {
  it('lists a project’s rows, its methodology’s and workspace-wide ones; workspace-wide leaves the methodology’s out', () => {
    expect(scopeWhere(null)).toEqual({ blueprintId: null });
    expect(scopeWhere({ projectId: 'p', blueprintId: null })).toEqual({ OR: [{ projectId: 'p' }, { projectId: null, blueprintId: null }] });
    expect(scopeWhere({ projectId: 'p', blueprintId: 'b' }).OR).toContainEqual({ projectId: null, blueprintId: 'b' });
  });

  it('shadows only through a methodology row: project over methodology over workspace', () => {
    const project = row('Rule', 'p', null);
    const owned = row('rule', null, 'b');
    const workspace = row('RULE', null, null);
    expect(shadowByScope([project, owned, workspace])).toEqual([project]);
    expect(shadowByScope([owned, workspace])).toEqual([owned]);
    // No methodology: a project row and a workspace row of one name both stay, as before.
    expect(shadowByScope([project, workspace])).toEqual([project, workspace]);
  });
});

describe('WorkflowsService with a methodology (#1123)', () => {
  function setup(linked: string | null) {
    const definitions = [
      { id: 'w-ws', workspaceId: 'ws', projectId: null, blueprintId: null, name: 'Review', enabled: true },
      { id: 'w-owned', workspaceId: 'ws', projectId: null, blueprintId: 'b', name: 'Draft rules', enabled: true, graph: { steps: [] } },
    ];
    const prisma = {
      project: { findUnique: vi.fn(async () => ({ blueprintId: linked })) },
      document: { findUnique: vi.fn(async () => ({ id: 'd', workspaceId: 'ws', projectId: 'p', title: 'Page' })) },
      workflowRun: { findMany: vi.fn(async () => []) },
      workflowDefinition: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => definitions.find((d) => d.id === where.id) ?? null),
        findMany: vi.fn(async ({ where }: { where: { OR: Record<string, unknown>[] } }) =>
          definitions.filter((d) => where.OR.some((w) => Object.entries(w).every(([k, v]) => (d as Record<string, unknown>)[k] === v))),
        ),
      },
    };
    const _ = undefined as never;
    return new WorkflowsService(prisma as never, _, _, _, _, _);
  }

  it('offers and starts a methodology’s workflow only on pages of a linked project', async () => {
    const names = async (linked: string | null) => (await setup(linked).runsForDocument('d')).available.map((a) => a.name);
    expect(await names(null)).toEqual(['Review']);
    expect(await names('b')).toEqual(['Review', 'Draft rules']);
    expect(await names('other')).toEqual(['Review']);

    const start = (linked: string | null) => setup(linked).startRun({ workspaceId: 'ws', definitionId: 'w-owned', rootDocumentId: 'd' }, 'u');
    await expect(start(null)).rejects.toThrow(/differentProject/);
    // Linked: past the scope check (the empty graph is the compiler's to refuse).
    await expect(start('b')).rejects.not.toThrow(/differentProject/);
  });
});
