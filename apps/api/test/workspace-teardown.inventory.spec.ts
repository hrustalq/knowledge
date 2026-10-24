import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { WORKSPACE_ROWS, WORKSPACE_TEARDOWN } from '../src/workspaces/workspace-teardown.inventory.js';

/**
 * #479: a workspace's teardown is only as complete as this inventory. A new
 * table must be filed before it ships, or a deleted workspace would leave its
 * rows behind with nothing pointing at them.
 */
describe('workspace teardown inventory', () => {
  const models = Prisma.dmmf.datamodel.models;
  const hasWorkspaceId = (name: string) => models.find((m) => m.name === name)!.fields.some((f) => f.name === 'workspaceId');

  it('files every Prisma model', () => {
    expect(Object.keys(WORKSPACE_TEARDOWN).sort()).toEqual(models.map((m) => m.name).sort());
  });

  it('deletes or deliberately keeps every table with a workspaceId', () => {
    const misfiled = models
      .filter((m) => hasWorkspaceId(m.name))
      .filter((m) => !['workspace', 'audit', 'page'].includes(WORKSPACE_TEARDOWN[m.name as Prisma.ModelName]))
      .map((m) => m.name);
    expect(misfiled).toEqual([]);
  });

  it('only deletes by workspaceId where the column exists', () => {
    expect(WORKSPACE_ROWS.filter((m) => !hasWorkspaceId(m))).toEqual([]);
  });

  it('clears what RESTRICTs a parent before the parent', () => {
    const at = (m: Prisma.ModelName) => WORKSPACE_ROWS.indexOf(m);
    expect(at('WorkflowRun')).toBeLessThan(at('WorkflowDefinition'));
    for (const child of ['GlossaryTerm', 'Connector', 'PublishedSite'] as const) expect(at(child)).toBeLessThan(at('Project'));
    expect(at('MergeRequestCheck')).toBeGreaterThanOrEqual(0);
    expect(WORKSPACE_ROWS.at(-1)).toBe('WorkspaceMember');
  });
});
