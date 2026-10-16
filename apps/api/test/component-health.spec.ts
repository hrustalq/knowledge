import { describe, expect, it, vi } from 'vitest';
import { missingPaths } from '../src/components/component-match.js';
import { ComponentsService } from '../src/components/components.service.js';
import { healthFilterSql } from '../src/verification/knowledge-health.service.js';

/**
 * Component pages, phase 6 (#236): which declared paths no file at the indexed
 * head answers to, how a pull records that on the declaration, and the
 * knowledge-health filter that reads it.
 */

describe('missingPaths', () => {
  const files = new Set(['apps/web/src/components/Popover.vue', 'apps/api/src/billing/index.ts', 'apps/api/src/billing/plan.ts']);

  it('keeps a file, a directory with files under it, and a glob that matches', () => {
    expect(
      missingPaths(['apps/web/src/components/Popover.vue', 'apps/api/src/billing/', 'apps/api/src/billing', 'apps/**/plan.ts'], files),
    ).toEqual([]);
  });

  it('reports a file that is gone, an emptied directory and a glob that matches nothing', () => {
    expect(missingPaths(['apps/web/src/components/Gone.vue', 'apps/api/src/users/', 'apps/**/*.py'], files)).toEqual([
      'apps/web/src/components/Gone.vue',
      'apps/api/src/users/',
      'apps/**/*.py',
    ]);
  });

  it('never matches a sibling that shares a prefix', () => {
    expect(missingPaths(['apps/api/src/bill'], files)).toEqual(['apps/api/src/bill']);
  });

  it('reports nothing while the head is unknown', () => {
    expect(missingPaths(['anything.ts'], null)).toEqual([]);
  });
});

describe('ComponentsService.rebuild', () => {
  function service(opts: { files: string[]; rows: Array<Record<string, unknown>>; connectors?: unknown[] }) {
    const update = vi.fn(async () => undefined);
    const prisma = {
      connector: {
        findMany: vi.fn(async () => opts.connectors ?? [{ id: 'c1', config: { repoUrl: 'https://github.com/acme/demo' } }]),
      },
      componentDeclaration: { findMany: vi.fn(async () => opts.rows), update },
      codeFile: {
        findMany: vi.fn(async ({ where }: { where: { connectorId: string } }) =>
          where.connectorId === 'c1' ? opts.files.map((path) => ({ path })) : [],
        ),
      },
      codeImport: { findMany: vi.fn(async () => []) },
      connectorLink: { findMany: vi.fn(async () => []) },
      document: { findMany: vi.fn(async () => []) },
    };
    const graph = { replaceCodeFacts: vi.fn(async () => 0) };
    return { svc: new ComponentsService(prisma as never, graph as never), update, prisma };
  }
  const row = (over: Record<string, unknown> = {}) => ({
    documentId: 'd1',
    workspaceId: 'w1',
    componentKey: 'component:popover',
    componentName: 'Popover',
    repository: null,
    connectorId: 'c1',
    paths: ['src/Popover.vue', 'src/Tip.vue'],
    symbols: [],
    warning: null,
    missingPaths: [],
    ...over,
  });

  it('records the declared paths the indexed head no longer has', async () => {
    const { svc, update } = service({ files: ['src/Popover.vue'], rows: [row()] });
    await svc.rebuild('w1');
    expect(update).toHaveBeenCalledWith({
      where: { documentId: 'd1' },
      data: { connectorId: 'c1', warning: null, missingPaths: ['src/Tip.vue'] },
    });
  });

  it('clears the list once the paths exist again, and writes nothing when nothing changed', async () => {
    const fixed = service({ files: ['src/Popover.vue', 'src/Tip.vue'], rows: [row({ missingPaths: ['src/Tip.vue'] })] });
    await fixed.svc.rebuild('w1');
    expect(fixed.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ missingPaths: [] }) }));

    const same = service({ files: ['src/Popover.vue'], rows: [row({ missingPaths: ['src/Tip.vue'] })] });
    await same.svc.rebuild('w1');
    expect(same.update).not.toHaveBeenCalled();
  });

  it('reports nothing missing for a connector never indexed with its files, or an unresolved declaration', async () => {
    const never = service({ files: [], rows: [row()] });
    await never.svc.rebuild('w1');
    expect(never.update).not.toHaveBeenCalled();

    // The connector is gone: the declaration warns instead, and its stale list is dropped.
    const gone = service({ files: ['src/Popover.vue'], rows: [row({ missingPaths: ['src/Tip.vue'] })], connectors: [] });
    await gone.svc.rebuild('w1');
    expect(gone.update).toHaveBeenCalledWith({
      where: { documentId: 'd1' },
      data: { connectorId: null, warning: 'no-connector', missingPaths: [] },
    });
  });
});

describe('the missing-paths health filter', () => {
  const settings = { reviewIntervalDays: 90, inactiveAfterDays: 180, emptyMaxChars: 200, expiringSoonDays: 14 };

  it('selects live pages with a missing declared path', () => {
    const sql = healthFilterSql('missing-paths', settings as never, new Date()).sql;
    expect(sql).toContain('r.archived_at IS NULL');
    expect(sql).toContain('cardinality(r.missing_paths) > 0');
  });
});
