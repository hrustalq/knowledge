import { markdownLinks } from '@knowledge/editor-schema/markdown';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Links between pages (#673): what a page's markdown points at, so a page can
 * be asked what links to it. Postgres only — the graph is unchanged.
 */

export interface PageLinkTarget {
  targetDocumentId: string;
  targetAnchor: string | null;
}

const PAGE_PATH = /^\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/**
 * The internal links in a body, one per (target, anchor). Read from the
 * editor's own parser, so code and images are never links. A link counts when
 * it resolves to `/documents/<id>` on `webBaseUrl`'s origin — the relative form
 * the editor writes and the absolute one a pasted address carries; another
 * origin (including protocol-relative `//host/…`) does not. A page's links to
 * itself are not backlinks.
 */
export function pageLinkTargets(markdown: string, webBaseUrl: string, selfId: string): PageLinkTarget[] {
  const origin = new URL(webBaseUrl).origin;
  const out = new Map<string, PageLinkTarget>();
  for (const { href } of markdownLinks(markdown)) {
    let url: URL;
    try {
      url = new URL(href, origin);
    } catch {
      continue;
    }
    const id = url.origin === origin ? PAGE_PATH.exec(url.pathname)?.[1]?.toLowerCase() : undefined;
    if (!id || id === selfId) continue;
    const anchor = decode(url.hash.slice(1)) || null;
    out.set(`${id}#${anchor ?? ''}`, { targetDocumentId: id, targetAnchor: anchor });
  }
  return [...out.values()];
}

function decode(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Replace a page's links with `revisionId`'s, only while that revision is the
 * default-branch head. The head row is share-locked for the transaction: a
 * finalize moving the head waits for it, and the new head's own job then
 * rewrites — so an older revision's job finishing late cannot put its links
 * back. False when `revisionId` is not the head (nothing written).
 */
export async function replacePageLinks(
  prisma: PrismaService,
  input: { workspaceId: string; documentId: string; revisionId: string; links: PageLinkTarget[] },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [head] = await tx.$queryRaw<Array<{ head_revision_id: string | null }>>`
      SELECT b.head_revision_id FROM document_branches b
      JOIN documents d ON d.id = b.document_id AND b.name = d.default_branch
      WHERE b.document_id = ${input.documentId}::uuid
      FOR SHARE OF b`;
    if (head?.head_revision_id !== input.revisionId) return false;
    await tx.pageLink.deleteMany({ where: { sourceDocumentId: input.documentId } });
    if (input.links.length) {
      await tx.pageLink.createMany({
        data: input.links.map((l) => ({
          workspaceId: input.workspaceId,
          sourceDocumentId: input.documentId,
          sourceRevisionId: input.revisionId,
          ...l,
        })),
      });
    }
    return true;
  });
}
