/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * `DocumentsService.writeRevision` (#811) for a spec's fake documents service:
 * composed from the fake's own `createRevision`, the revision row's key, the
 * storage PUT and `finalizeRevision` — the three steps the real method runs in
 * one boundary — so a spec keeps asserting on those calls.
 */
export function fakeWriteRevision(deps: {
  documents: { createRevision: (...a: any[]) => Promise<{ revisionId: string }>; finalizeRevision: (...a: any[]) => Promise<unknown> };
  storage: { putObjectText: (...a: any[]) => Promise<unknown> };
  prisma: { documentRevision: { findUnique: (...a: any[]) => Promise<any> } };
}) {
  return async (
    documentId: string,
    input: { text: string; branch?: string; message?: string; contentType?: string; expectedHeadRevisionId?: string },
    by: unknown,
    ...rest: [authorId?: string, writer?: { connectorId: string }]
  ): Promise<{ revisionId: string }> => {
    const { text, expectedHeadRevisionId, ...dto } = input;
    const args: unknown[] = [documentId, dto, by, expectedHeadRevisionId, ...rest];
    while (args.length > 3 && args[args.length - 1] === undefined) args.pop();
    const { revisionId } = await deps.documents.createRevision(...args);
    const row = await deps.prisma.documentRevision.findUnique({ where: { id: revisionId } });
    await deps.storage.putObjectText(row.s3Key, text, row.contentType ?? dto.contentType);
    await deps.documents.finalizeRevision(documentId, revisionId);
    return { revisionId };
  };
}
