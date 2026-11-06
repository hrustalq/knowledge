import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AiProvidersService } from '../src/ai/ai-providers.service.js';
import { ApiSpecDiffService } from '../src/api-specs/api-spec-diff.service.js';
import { ConnectorLinksService } from '../src/connectors/connector-links.service.js';
import { FeedbackDatasetService } from '../src/feedback/feedback-dataset.service.js';

/**
 * `@Access` checks the one id it resolves, so a second id in the request is the
 * service's to check (#789). Each case runs with workspace A's caller and
 * workspace B's row; the fakes apply `where` as Postgres would.
 */

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

describe('feedback titles', () => {
  it('a planted id from another workspace resolves to no title', async () => {
    const pages = [
      { id: 'doc-a', workspaceId: WS_A, title: 'Ours' },
      { id: 'doc-b', workspaceId: WS_B, title: 'Their secret plan' },
    ];
    const prisma = {
      answerFeedback: {
        findMany: vi.fn(async () => [
          { id: 'f-1', workspaceId: WS_A, citedDocumentIds: ['doc-a', 'doc-b'], createdAt: new Date(), query: 'q' },
        ]),
      },
      document: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; workspaceId?: string } }) =>
          pages.filter((p) => where.id.in.includes(p.id) && (where.workspaceId === undefined || p.workspaceId === where.workspaceId)),
        ),
      },
    };
    const { entries } = await new FeedbackDatasetService(prisma as never).list(WS_A, {});
    expect(JSON.stringify(entries)).toContain('Ours');
    expect(JSON.stringify(entries)).not.toContain('Their secret plan');
  });
});

describe('spec diff', () => {
  const DOC = 'doc-a';
  const revisions = [
    { id: 'rev-1', documentId: DOC, contentHash: 'h1', s3Key: 'k1', status: 'indexed' },
    { id: 'rev-2', documentId: DOC, contentHash: 'h2', s3Key: 'k2', status: 'indexed' },
    { id: 'rev-b1', documentId: 'doc-b', contentHash: 'h3', s3Key: 'k3', status: 'indexed' },
    { id: 'rev-b2', documentId: 'doc-b', contentHash: 'h4', s3Key: 'k4', status: 'indexed' },
  ];
  const cachedSecret = { summary: { breaking: 1, nonBreaking: 0, info: 0 }, changes: [{ path: '/their/secret' }] };

  function service() {
    const prisma = {
      document: { findUnique: vi.fn(async () => ({ kind: 'openapi', specSlug: 'a' })) },
      documentRevision: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; documentId: string } }) =>
          revisions.filter((r) => where.id.in.includes(r.id) && r.documentId === where.documentId),
        ),
        // The old path: read by id alone, after the cache.
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => revisions.find((r) => r.id === where.id) ?? null),
      },
      revisionDiff: { findUnique: vi.fn(async () => ({ changes: cachedSecret })), create: vi.fn(async () => ({})) },
    };
    return { prisma, diffs: new ApiSpecDiffService(prisma as never, {} as never, {} as never) };
  }

  it('refuses a cached diff of another document before reading the cache', async () => {
    const { prisma, diffs } = service();
    await expect(diffs.diff(DOC, 'rev-b1', 'rev-b2')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.revisionDiff.findUnique).not.toHaveBeenCalled();
  });

  it('refuses when only one side is foreign, and when there is no `from`', async () => {
    const { diffs } = service();
    await expect(diffs.diff(DOC, 'rev-1', 'rev-b2')).rejects.toBeInstanceOf(NotFoundException);
    await expect(diffs.diff(DOC, 'rev-b1', 'rev-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(diffs.diff(DOC, null, 'rev-b1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(diffs.diff(DOC, 'rev-b1', 'rev-b1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still serves the document own cached diff', async () => {
    const { diffs } = service();
    await expect(diffs.diff(DOC, 'rev-1', 'rev-2')).resolves.toMatchObject({ documentId: DOC, summary: cachedSecret.summary });
  });
});

describe('provider check', () => {
  function service() {
    const rows = [
      { id: 'p-a', workspaceId: WS_A, lastStatus: null as string | null, lastError: null as string | null },
      { id: 'p-b', workspaceId: WS_B, lastStatus: 'ok' as string | null, lastError: null as string | null },
    ];
    const write = (where: { id: string; workspaceId?: string }, data: { lastStatus: string; lastError: string | null }) => {
      const hit = rows.filter((r) => r.id === where.id && (where.workspaceId === undefined || r.workspaceId === where.workspaceId));
      hit.forEach((r) => Object.assign(r, data));
      return hit;
    };
    const aiProvider = {
      updateMany: vi.fn(async ({ where, data }: never) => ({ count: write(where, data).length })),
      update: vi.fn(async ({ where, data }: never) => write(where, data)[0]),
    };
    const svc = Object.create(AiProvidersService.prototype) as AiProvidersService;
    Object.assign(svc, { prisma: { aiProvider }, cache: new Map() });
    return { rows, svc };
  }

  it('leaves another workspace\'s profile untouched', async () => {
    const { rows, svc } = service();
    await svc.recordCheck(WS_A, 'p-b', false, 'overwritten');
    expect(rows[1]).toMatchObject({ lastStatus: 'ok', lastError: null });
  });

  it('records on its own workspace\'s profile', async () => {
    const { rows, svc } = service();
    await svc.recordCheck(WS_A, 'p-a', false, 'boom');
    expect(rows[0]).toMatchObject({ lastStatus: 'error', lastError: 'boom' });
  });
});

describe('connector link removal', () => {
  function service() {
    const links = [
      { id: 'l-a', connectorId: 'c-a' },
      { id: 'l-b', connectorId: 'c-b' },
    ];
    const drop = (where: { id: string; connectorId?: string }) => {
      const before = links.length;
      for (let i = links.length - 1; i >= 0; i--) {
        if (links[i].id === where.id && (where.connectorId === undefined || links[i].connectorId === where.connectorId)) links.splice(i, 1);
      }
      return before - links.length;
    };
    const connectorLink = {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => links.find((l) => l.id === where.id) ?? null),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => drop(where)),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; connectorId: string } }) => ({ count: drop(where) })),
    };
    return { links, svc: new ConnectorLinksService({ connectorLink } as never) };
  }

  it('refuses a link of another connector and keeps it', async () => {
    const { links, svc } = service();
    await expect(svc.remove('c-a', 'l-b')).rejects.toBeInstanceOf(NotFoundException);
    expect(links.map((l) => l.id)).toContain('l-b');
  });

  it('removes through the owning connector', async () => {
    const { links, svc } = service();
    await svc.remove('c-a', 'l-a');
    expect(links.map((l) => l.id)).toEqual(['l-b']);
  });
});
