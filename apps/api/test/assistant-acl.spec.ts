import { describe, expect, it, vi } from 'vitest';
import { AssistantReadToolsService } from '../src/assistant/assistant-read-tools.service.js';
import { AssistantToolsService } from '../src/assistant/assistant.tools.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import type { AccessScope } from '../src/permissions/access-scope.js';

/**
 * The assistant's tools under page permissions (issue #76, phase 4).
 *
 * What is pinned:
 * 1. **A page the caller cannot open is "not found"** to the model — the same
 *    words as a page that does not exist, and its content is never read.
 * 2. **Visibility is asked on every call.** A grant revoked between two calls
 *    of one turn holds from the second.
 * 3. **The audience reaches the scope.** A run whose output others read (a
 *    group chat, an agent's findings) has every read clamped.
 * 4. **Edit tools need edit on the page**, not just the editor role.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const ctx = { principal: DEV_PRINCIPAL, workspaceId: WS };
const owner = { workspaceId: WS, bypass: false } as unknown as AccessScope;
const clamped = { workspaceId: WS, bypass: false, clamped: true } as unknown as AccessScope;

function readTools(visible: () => boolean) {
  const permissions = {
    scopeFor: vi.fn(async () => owner),
    audienceScope: vi.fn(async () => clamped),
    visibleDocumentIds: vi.fn(async (_s: AccessScope, ids: string[]) => new Set(visible() ? ids : [])),
    auditBypassRead: vi.fn(async () => undefined),
  };
  const documents = {
    getContent: vi.fn(async () => ({ revisionId: 'r-1', markdown: '# Salaries', frontmatter: null })),
    breadcrumbsFor: vi.fn(async () => new Map()),
  };
  const prisma = { document: { findUnique: vi.fn(async () => ({ id: PAGE, workspaceId: WS, title: 'Salaries' })) } };
  const tools = new AssistantReadToolsService(
    { requireRole: vi.fn(async () => undefined) } as never,
    prisma as never,
    {} as never,
    documents as never,
    {} as never,
    permissions as never,
  );
  return { tools, permissions, documents };
}

describe('assistant read tools', () => {
  it('answers "not found" for a page the caller cannot open, without reading it', async () => {
    const { tools, documents } = readTools(() => false);
    const res = await tools.execute('read_document', { documentId: PAGE }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain(`Document ${PAGE} not found in this workspace`);
    expect(res.content).not.toContain('Salaries');
    expect(documents.getContent).not.toHaveBeenCalled();

    for (const name of ['explore_document_graph', 'list_relations']) {
      const other = await tools.execute(name, { documentId: PAGE }, ctx);
      expect(other.ok, name).toBe(false);
    }
  });

  it('asks again on every call, so a revocation mid-turn holds from the next one', async () => {
    let open = true;
    const { tools, permissions } = readTools(() => open);
    expect((await tools.execute('read_document', { documentId: PAGE }, ctx)).ok).toBe(true);
    open = false;
    expect((await tools.execute('read_document', { documentId: PAGE }, ctx)).ok).toBe(false);
    expect(permissions.scopeFor).toHaveBeenCalledTimes(2);
  });

  it('clamps every read to the run’s audience when it has one', async () => {
    const { tools, permissions } = readTools(() => true);
    await tools.execute('read_document', { documentId: PAGE }, { ...ctx, audience: { kind: 'workspace' } });
    expect(permissions.audienceScope).toHaveBeenCalledWith(owner, { kind: 'workspace' });
    expect(permissions.visibleDocumentIds).toHaveBeenCalledWith(clamped, [PAGE]);

    permissions.audienceScope.mockClear();
    await tools.execute('read_document', { documentId: PAGE }, ctx);
    expect(permissions.audienceScope).not.toHaveBeenCalled();
  });
});

describe('assistant write tools', () => {
  function writeTools(level: string) {
    const svc = Object.create(AssistantToolsService.prototype) as AssistantToolsService;
    const documents = { createBranch: vi.fn() };
    Object.assign(svc, {
      access: { requireRole: vi.fn(async () => undefined) },
      prisma: { document: { findUnique: vi.fn(async () => ({ id: PAGE, workspaceId: WS, title: 'Salaries' })) } },
      permissions: { scopeFor: vi.fn(async () => owner), levelFor: vi.fn(async () => level) },
      documents,
      logger: { warn: vi.fn() },
    });
    return { svc, documents };
  }

  it('refuses propose_update on a page the caller can read but not edit', async () => {
    const { svc, documents } = writeTools('view');
    const res = await svc.execute('propose_update', { documentId: PAGE, title: 't', markdown: 'x' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('but not edit it');
    expect(documents.createBranch).not.toHaveBeenCalled();
  });

  it('treats a page the caller cannot open as missing', async () => {
    const { svc } = writeTools('none');
    const res = await svc.execute('edit_relations', { documentId: PAGE, add: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('not found in this workspace');
    expect(res.content).not.toContain('Salaries');
  });
});
