import { slugifyPath, type SiteBuildWarning } from '@knowledge/contracts';

/**
 * What one site build publishes, decided without touching a database
 * (docs/features/44). `SiteBuildService` reads the rows, this decides, and the
 * service writes the answer in one transaction — so every rule below is
 * pinned by a spec without a fake Prisma in the way.
 */

export interface PlanDocument {
  id: string;
  parentId: string | null;
  title: string;
  position: number;
}

/** The revision a page publishes, as `resolveRevision` chose it. */
export type ResolvedRevision =
  | { revisionId: string; headIndexed: boolean }
  | { revisionId: null };

export interface PlanInput {
  /** Every live (unarchived, unrestricted) page in scope: the project, or the root's subtree. */
  documents: PlanDocument[];
  /** documentId → what it publishes. A page missing here publishes nothing. */
  revisions: Map<string, ResolvedRevision>;
  /** Set when the site is one page and its subtree: that page is the site's home, at `''`. */
  rootDocumentId: string | null;
  /** Segments a top-level page may not take: the site's version slugs, which own the first segment of a URL. */
  reservedTopSegments: ReadonlySet<string>;
  maxPages: number;
}

export interface PlannedPage {
  documentId: string;
  revisionId: string;
  /** The nearest published ancestor; null at the top of the site. */
  parentId: string | null;
  position: number;
  depth: number;
  slugPath: string;
  title: string;
}

export interface SitePlan {
  pages: PlannedPage[];
  warnings: SiteBuildWarning[];
}

/** Used when a title has nothing slugifiable in it ("???", an emoji). */
const FALLBACK_SEGMENT = 'page';

/**
 * The head of the branch a version reads, or the newest indexed revision
 * before it. A draft, a revision still indexing or one that failed is never
 * published: the reader would see a page the search and the graph have not.
 */
export function resolveRevision(
  head: { id: string; status: string } | null,
  latestIndexed: { id: string } | null,
): ResolvedRevision {
  if (head?.status === 'indexed') return { revisionId: head.id, headIndexed: true };
  if (latestIndexed) return { revisionId: latestIndexed.id, headIndexed: false };
  return { revisionId: null };
}

/**
 * Walk the tree in reading order (position, then title — the order the app's
 * own tree draws) and publish every page that has a revision to publish.
 *
 * - A page with nothing to publish is left out, and its subpages hang from its
 *   nearest published ancestor in its place, so leaving one page out never
 *   hides a branch of the tree.
 * - A page whose parent is not in scope is a top-level page — the orphan rule
 *   `DocumentsService.getTree` already uses.
 * - Slugs come from titles, one segment per level, deduplicated among
 *   siblings with `-2`, `-3`. At the top level they also step around the
 *   version slugs, which own a URL's first segment.
 * - With a root page, the root is the home page at `''` and its subpages are
 *   at the top of the URL space rather than under the root's own title.
 * - Past `maxPages` the rest is cut, in reading order, with one warning.
 */
export function planSiteBuild(input: PlanInput): SitePlan {
  const inScope = new Set(input.documents.map((d) => d.id));
  const children = new Map<string | null, PlanDocument[]>();
  for (const doc of input.documents) {
    const parent = doc.parentId && inScope.has(doc.parentId) && doc.id !== input.rootDocumentId ? doc.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(doc);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }

  const pages: PlannedPage[] = [];
  const warnings: SiteBuildWarning[] = [];
  /** Segments taken under each published parent (null = the top). */
  const taken = new Map<string | null, Set<string>>();
  /** Next position under each published parent. */
  const nextPosition = new Map<string | null, number>();
  const slugOf = new Map<string, string>();
  const depthOf = new Map<string, number>();
  let cut = false;

  const segmentFor = (parent: string | null, title: string): string => {
    const used = taken.get(parent) ?? new Set<string>(parent === null ? input.reservedTopSegments : []);
    taken.set(parent, used);
    // `slugifyPath` keeps a run of hyphens ("API - Overview" → `api---overview`)
    // because heading anchors already in links depend on it; a URL segment has
    // no such history, so it gets the tidy form.
    const base = slugifyPath(title).replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '') || FALLBACK_SEGMENT;
    let segment = base;
    for (let n = 2; used.has(segment); n++) segment = `${base}-${n}`;
    used.add(segment);
    return segment;
  };

  const visit = (doc: PlanDocument, publishedParent: string | null): void => {
    if (cut) return;
    const resolved = input.revisions.get(doc.id) ?? { revisionId: null };
    let parentForChildren = publishedParent;

    if (resolved.revisionId === null) {
      warnings.push({ code: 'noIndexedRevision', documentId: doc.id, title: doc.title });
    } else if (pages.length >= input.maxPages) {
      cut = true;
      warnings.push({ code: 'pageLimit', documentId: null, title: null });
      return;
    } else {
      if (!resolved.headIndexed) warnings.push({ code: 'headNotIndexed', documentId: doc.id, title: doc.title });
      const isHome = doc.id === input.rootDocumentId;
      const parentSlug = publishedParent ? slugOf.get(publishedParent)! : '';
      // The home page's own segment is ''; its subpages live at the top of the
      // URL space, so they are deduplicated (and reserved-checked) as top level.
      const slugParent = publishedParent === input.rootDocumentId ? null : publishedParent;
      const slugPath = isHome ? '' : [parentSlug, segmentFor(slugParent, doc.title)].filter(Boolean).join('/');
      const depth = publishedParent ? depthOf.get(publishedParent)! + 1 : 0;
      const position = nextPosition.get(publishedParent) ?? 0;
      nextPosition.set(publishedParent, position + 1);
      slugOf.set(doc.id, slugPath);
      depthOf.set(doc.id, depth);
      pages.push({
        documentId: doc.id,
        revisionId: resolved.revisionId,
        parentId: publishedParent,
        position,
        depth,
        slugPath,
        title: doc.title,
      });
      parentForChildren = doc.id;
    }

    for (const child of children.get(doc.id) ?? []) visit(child, parentForChildren);
  };

  for (const top of children.get(null) ?? []) visit(top, null);
  return { pages, warnings };
}
