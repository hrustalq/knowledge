import { describe, expect, it, vi } from 'vitest';
import { AttachmentsService } from '../src/attachments/attachments.service.js';
import { DocumentsService } from '../src/documents/documents.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';

/** #755: an act a person performed names them, not the dev actor. */
describe('activity attribution', () => {
  it('names who confirmed or deleted an attachment', async () => {
    const row = { id: 'a1', workspaceId: WS, documentId: 'd1', s3Key: 'k', filename: 'f', contentType: 'text/plain', sizeBytes: 1, createdAt: new Date(0) };
    const activity = { record: vi.fn(async () => undefined) };
    const prisma = { attachment: { findUnique: vi.fn(async () => row), update: vi.fn(async () => row), delete: vi.fn(async () => row) } };
    const storage = { headObject: vi.fn(async () => ({ contentLength: 1 })), deleteObject: vi.fn(async () => undefined) };
    const svc = new AttachmentsService(prisma as never, storage as never, activity as never, { get: () => 100 } as never);

    await svc.complete('d1', 'a1', ALICE);
    await svc.remove('d1', 'a1', ALICE);

    expect(activity.record.mock.calls.map(([input]: unknown[]) => input)).toEqual([
      expect.objectContaining({ action: 'attachment.created', actor: ALICE }),
      expect.objectContaining({ action: 'attachment.deleted', actor: ALICE }),
    ]);
  });

  it('names who curated or deleted a relation', async () => {
    const activity = { record: vi.fn(async () => undefined) };
    const svc = Object.assign(Object.create(DocumentsService.prototype), {
      activity,
      prisma: { documentBranch: { findUnique: vi.fn(async () => null) } },
      graph: { curateRelation: vi.fn(async () => undefined), deleteRelations: vi.fn(async () => undefined) },
      getDocumentOrThrow: vi.fn(async () => ({ workspaceId: WS, defaultBranch: 'main', title: 'T' })),
      listRelations: vi.fn(async () => ({ relations: [] })),
      toFacts: () => [{ type: 'RELATED_TO', target: { key: 'x:y' } }],
    }) as DocumentsService;

    await svc.curateRelation('d1', {} as never, ALICE);
    await svc.deleteRelation('d1', 'RELATED_TO', 'x:y', undefined, ALICE);

    expect(activity.record.mock.calls.map(([input]: unknown[]) => input)).toEqual([
      expect.objectContaining({ action: 'relations.curated', actor: ALICE }),
      expect.objectContaining({ action: 'relations.deleted', actor: ALICE }),
    ]);
  });
});
