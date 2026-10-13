import { zipSync, type Zippable } from 'fflate';
import {
  EXPORT_MANIFEST_VERSION,
  slugifyPath,
  type ExportManifest,
  type ExportManifestPage,
  type ExportScope,
} from '@knowledge/contracts';

/**
 * How an export is laid out on disk (docs/features/45), decided without
 * touching a database or the network, so the shape of every archive is pinned
 * by a spec. ExportBuildService reads the rows and the bytes; this names the
 * paths, writes the manifest and zips.
 */

export interface PackagedPage {
  documentId: string;
  title: string;
  category: string;
  parentId: string | null;
  position: number;
  depth: number;
  /** From `planSiteBuild`: one title-derived segment per level, unique among siblings. */
  slugPath: string;
  revisionId: string;
  branch: string;
  /** The revision exactly as stored, frontmatter included. */
  source: string;
  /** Frontmatter stripped, for rendering. */
  markdown: string;
}

export interface PackagedAttachment {
  id: string;
  documentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/** A path segment that cannot climb out of its folder or name a device. */
export function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120) || 'file';
}

/** `.png`, or '' when the name has no believable extension. */
function extensionOf(filename: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filename);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/** The folder an archive unpacks into, so it never spills over whatever directory it is opened in. */
export function archiveRoot(title: string): string {
  return slugifyPath(title).replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'export';
}

/** ZIP: one markdown source per page, mirroring the tree. */
export function pageSourcePath(page: Pick<PackagedPage, 'slugPath'>): string {
  return `pages/${page.slugPath}.md`;
}

/** HTML bundle: one file per page, mirroring the tree. */
export function pageHtmlPath(page: Pick<PackagedPage, 'slugPath'>): string {
  return `pages/${page.slugPath}.html`;
}

/** ZIP: an attachment keeps its own name, under its id so two `diagram.png` cannot collide. */
export function attachmentArchivePath(a: Pick<PackagedAttachment, 'id' | 'filename'>): string {
  return `attachments/${a.id}/${safeFilename(a.filename)}`;
}

/** HTML bundle: `assets/<id>.<ext>`. */
export function htmlAssetPath(a: Pick<PackagedAttachment, 'id' | 'filename'>): string {
  return `assets/${a.id}${extensionOf(a.filename)}`;
}

/** PDF: Gotenberg takes a flat folder of files beside index.html. */
export function pdfAssetName(a: Pick<PackagedAttachment, 'id' | 'filename'>): string {
  return `asset-${a.id}${extensionOf(a.filename)}`;
}

export function buildManifest(input: {
  workspaceId: string;
  scope: ExportScope;
  rootDocumentId: string | null;
  projectId: string | null;
  branch: string | null;
  title: string;
  exportedAt: Date;
  pages: PackagedPage[];
  attachments: PackagedAttachment[];
}): ExportManifest {
  const byDocument = new Map<string, PackagedAttachment[]>();
  for (const a of input.attachments) {
    const list = byDocument.get(a.documentId) ?? [];
    list.push(a);
    byDocument.set(a.documentId, list);
  }
  const pages: ExportManifestPage[] = input.pages.map((p) => ({
    documentId: p.documentId,
    title: p.title,
    category: p.category,
    parentId: p.parentId,
    position: p.position,
    depth: p.depth,
    revisionId: p.revisionId,
    branch: p.branch,
    path: pageSourcePath(p),
    attachments: (byDocument.get(p.documentId) ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      path: attachmentArchivePath(a),
    })),
  }));
  return {
    format: 'knowledge-export',
    version: EXPORT_MANIFEST_VERSION,
    exportedAt: input.exportedAt.toISOString(),
    workspaceId: input.workspaceId,
    scope: input.scope,
    rootDocumentId: input.rootDocumentId,
    projectId: input.projectId,
    branch: input.branch,
    title: input.title,
    pages,
  };
}

/**
 * Zip `files` under one top folder. Already-compressed formats are stored
 * rather than deflated again, which costs time and saves nothing.
 */
export function zipArchive(root: string, files: { path: string; bytes: Uint8Array }[]): Uint8Array {
  const tree: Zippable = {};
  for (const file of files) {
    const level = /\.(png|jpe?g|gif|webp|avif|zip|gz|pdf|mp4|webm|mp3|woff2?)$/i.test(file.path) ? 0 : 6;
    tree[`${root}/${file.path}`] = [file.bytes, { level }];
  }
  return zipSync(tree);
}
