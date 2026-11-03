import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DocumentsService } from '../src/documents/documents.service.js';

/**
 * #716 phase 3: a collection's rule is written by `PATCH /v1/documents/:id`.
 * The template is resolved in the page's workspace and stored canonically;
 * a blank pattern clears the rule rather than numbering every child "".
 */
const WS = '11111111-1111-4111-8111-111111111111';
const _ = {} as never;

function service(resolve: (ws: string, ref: string) => Promise<{ ref: string }>) {
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'd1', title: 'Decisions', ...data }));
  const prisma = { withTransaction: (fn: () => Promise<unknown>) => fn(), document: { update } };
  const templates = { resolve: vi.fn(resolve) };
  const activity = { record: vi.fn(async () => undefined) };
  const svc = new DocumentsService(prisma as never, _, _, _, activity as never, _, _, _, _, templates as never, _, _, _, _, _, _);
  Object.assign(svc, {
    getDocumentOrThrow: async () => ({ id: 'd1', workspaceId: WS, projectId: 'p1', archivedAt: null, title: 'Decisions', parentId: null }),
    toSummary: async (row: unknown) => row,
  });
  return { svc, update, templates };
}

describe('collection rule (#716)', () => {
  it('stores the canonical template ref and the pattern as typed', async () => {
    const { svc, update, templates } = service(async () => ({ ref: 'builtin:adr' }));
    await svc.updateDocument('d1', { childTemplateRef: ' builtin:adr ', childTitlePattern: 'ADR {{n:4}}: ' }, 'u1');
    expect(templates.resolve).toHaveBeenCalledWith(WS, ' builtin:adr ');
    expect(update.mock.calls[0]![0].data).toMatchObject({ childTemplateRef: 'builtin:adr', childTitlePattern: 'ADR {{n:4}}: ' });
  });

  it('clears the rule with null or a blank pattern, without resolving anything', async () => {
    const { svc, update, templates } = service(async () => ({ ref: 'x' }));
    await svc.updateDocument('d1', { childTemplateRef: null, childTitlePattern: '   ' }, 'u1');
    expect(templates.resolve).not.toHaveBeenCalled();
    expect(update.mock.calls[0]![0].data).toMatchObject({ childTemplateRef: null, childTitlePattern: null });
  });

  it('refuses a template the workspace cannot resolve, writing nothing', async () => {
    const { svc, update } = service(async () => {
      throw new NotFoundException('no such template');
    });
    await expect(svc.updateDocument('d1', { childTemplateRef: 'builtin:nope' }, 'u1')).rejects.toThrow('no such template');
    expect(update).not.toHaveBeenCalled();
  });
});
