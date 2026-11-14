import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { DocumentsController } from '../src/documents/documents.controller.js';
import { AiUsageService } from '../src/ai/ai-usage.service.js';

/**
 * #1109: a page size or a depth from the query string is clamped before it
 * reaches a query. `limit=NaN` was a 500 (Prisma's `take: NaN`), `limit=1e9`
 * an unbounded read, and a negative `take` reads backwards.
 */
const WS = '11111111-1111-4111-8111-111111111111';

function controller() {
  const documents = { listDocuments: vi.fn(async () => ({ items: [], nextCursor: null })), getTree: vi.fn(async () => ({ roots: [] })) };
  const c = Object.assign(Object.create(DocumentsController.prototype), { documents, permissions: { scopeFor: vi.fn(async () => ({ workspaceId: WS })) } }) as DocumentsController;
  return { c, documents };
}

describe('list limits (#1109)', () => {
  it('GET /v1/documents: limit is a number from 1 to 200, else the default', async () => {
    const { c, documents } = controller();
    for (const [raw, want] of [['NaN', 20], ['abc', 20], ['1000000000', 200], ['0', 1], ['-5', 1], ['50', 50], [undefined, 20]] as const) {
      await c.list({} as never, WS, raw);
      expect(documents.listDocuments.mock.calls.at(-1)![1], String(raw)).toBe(want);
    }
  });

  it('GET /v1/documents/tree: depth has a ceiling, and a bad one is one level', async () => {
    const { c, documents } = controller();
    for (const [raw, want] of [['999999', 10], ['NaN', 1], ['0', 1], ['2', 2]] as const) {
      await c.tree({} as never, WS, undefined, undefined, raw);
      expect((documents.getTree.mock.calls.at(-1) as unknown[])[2], raw).toMatchObject({ depth: want });
    }
  });

  it('AI usage logs: a limit below one never reaches Prisma', async () => {
    const findMany = vi.fn(async () => []);
    const svc = Object.assign(Object.create(AiUsageService.prototype), { prisma: { aiUsage: { findMany }, user: { findMany: vi.fn(async () => []) } } }) as AiUsageService;
    for (const limit of [0, -10, Number.NaN]) {
      await svc.listLogs(WS, { limit }).catch(() => undefined);
      expect((findMany.mock.calls.at(-1) as unknown as [{ take: number }])[0].take, String(limit)).toBeGreaterThanOrEqual(2);
    }
  });
});
