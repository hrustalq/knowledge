import { Injectable, Logger } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import { canonicalEmbedUrl, parseEmbedUrl, type EmbedRef } from '@knowledge/contracts';
import { embedGroupMarkup, embedGroupsOf, rewriteEmbedGroups } from '@knowledge/editor-schema/markdown';
import { ConnectorsService } from '../connectors/connectors.service.js';
import type { ConnectorContext } from '../connectors/adapters/connector.types.js';
import { figmaAllowedFiles, figmaGet } from '../connectors/adapters/figma.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { embedFileAllowed } from './embed-access.js';

/** A frame, section or page child the picker can offer (#470). */
export interface FigmaFrameEntry {
  id: string;
  name: string;
  type: string;
  thumbnailUrl: string | null;
}

/** Top-level children of a page worth embedding; everything else is reached by pasting a link. */
const PICKABLE = new Set(['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'GROUP']);
/** Thumbnails rendered per request; Figma caps `ids` by URL length, not count. */
const THUMBS_PER_CALL = 50;

/**
 * Which Figma files a workspace may embed, and the API-side Figma calls the
 * editor's picker makes (#470, docs/features/64). Shared by the worker (a
 * render resolves its file here) and the API (the picker), so both read the
 * allowlist the same way. Every call carries the connector's token; none of
 * it reaches the browser.
 */
@Injectable()
export class FigmaFilesService {
  private readonly logger = new Logger(FigmaFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
  ) {}

  /**
   * The enabled Figma connector whose allowlist reaches this file, refreshing
   * `embed_files` from a listing when the file is unknown or no longer
   * reached. Null when none does.
   */
  async connectorFor(workspaceId: string, fileKey: string): Promise<Connector | null> {
    const connectors = await this.enabledConnectors(workspaceId);
    const file = await this.prisma.embedFile.findUnique({ where: { workspaceId_provider_fileKey: { workspaceId, provider: 'figma', fileKey } } });
    const current = connectors.find((c) => c.id === file?.connectorId);
    if (file && current && embedFileAllowed(file, current)) return current;
    for (const connector of connectors) {
      const files = await this.refresh(connector);
      if (files?.some((f) => f.fileKey === fileKey)) return connector;
    }
    return null;
  }

  /** Every file the workspace's allowlists reach, freshly listed; a connector Figma refuses keeps its last listing. */
  async files(workspaceId: string): Promise<Array<{ fileKey: string; name: string }>> {
    for (const connector of await this.enabledConnectors(workspaceId)) await this.refresh(connector);
    const rows = await this.prisma.embedFile.findMany({ where: { workspaceId, provider: 'figma' }, orderBy: { name: 'asc' } });
    const enabled = new Map((await this.enabledConnectors(workspaceId)).map((c) => [c.id, c]));
    return rows.filter((r) => embedFileAllowed(r, enabled.get(r.connectorId))).map((r) => ({ fileKey: r.fileKey, name: r.name }));
  }

  /** Whether any Figma connector is on: without one, the picker explains instead of listing nothing. */
  async connected(workspaceId: string): Promise<boolean> {
    return (await this.enabledConnectors(workspaceId)).length > 0;
  }

  /** A file's pages and their pickable top-level children, with thumbnails, at the file's current version. */
  async frames(workspaceId: string, fileKey: string) {
    const ctx = await this.contextFor(workspaceId, fileKey);
    if (!ctx) return null;
    const file = await figmaGet<{ name: string; version: string; editorType?: string; document?: { children?: FigmaChild[] } }>(ctx, `/v1/files/${fileKey}`, {
      depth: '2',
    });
    const pages = (file.document?.children ?? []).map((page) => ({
      id: page.id,
      name: page.name,
      frames: (page.children ?? []).filter((c) => PICKABLE.has(c.type)).map((c) => ({ id: c.id, name: c.name, type: c.type, thumbnailUrl: null as string | null })),
    }));
    const ids = pages.flatMap((p) => p.frames.map((f) => f.id));
    const thumbs = new Map<string, string | null>();
    for (let i = 0; i < ids.length; i += THUMBS_PER_CALL) {
      const batch = ids.slice(i, i + THUMBS_PER_CALL);
      const { images } = await figmaGet<{ images?: Record<string, string | null> }>(ctx, `/v1/images/${fileKey}`, {
        ids: batch.join(','),
        version: file.version,
        format: 'png',
        scale: '0.25',
      }).catch((err: unknown) => {
        // Thumbnails are a convenience: a picker with names only still works.
        this.logger.warn(`Figma thumbnails for ${fileKey} failed: ${(err as Error).message}`);
        return { images: {} as Record<string, string | null> };
      });
      for (const id of batch) thumbs.set(id, images?.[id] ?? null);
    }
    for (const page of pages) for (const frame of page.frames) frame.thumbnailUrl = thumbs.get(frame.id) ?? null;
    return { fileKey, name: file.name, version: file.version, board: file.editorType === 'figjam', pages };
  }

  /**
   * One pasted link, pinned to the file's current version: the canonical URL,
   * the version and the node's name as a caption. `allowed: false` when no
   * allowlist reaches the file — the editor keeps it as a link.
   */
  async resolve(workspaceId: string, url: string): Promise<{ url: string; version: string | null; name: string | null; allowed: boolean } | null> {
    const ref = parseEmbedUrl(url);
    if (!ref) return null;
    const canonical = canonicalEmbedUrl(ref);
    const ctx = await this.contextFor(workspaceId, ref.fileKey);
    if (!ctx) return { url: canonical, version: null, name: null, allowed: false };
    const { version, name } = await this.pin(ctx, ref);
    return { url: canonical, version, name, allowed: true };
  }

  /**
   * Pin every unpinned Figma item in a pulled page to its file's current
   * version (#470). An item no allowlist reaches, or that Figma refuses, stays
   * unpinned — kept, shown as a link, warned — so a pull never fails over one.
   */
  async pinMarkdown(workspaceId: string, markdown: string): Promise<string> {
    const unpinned = embedGroupsOf(markdown).some((g) => g.items.some((i) => !i.version && parseEmbedUrl(i.url)));
    if (!unpinned) return markdown;
    const versions = new Map<string, { version: string; name: string | null } | null>();
    for (const group of embedGroupsOf(markdown)) {
      for (const item of group.items) {
        const ref = parseEmbedUrl(item.url);
        if (!ref || item.version || versions.has(item.url)) continue;
        const ctx = await this.contextFor(workspaceId, ref.fileKey);
        versions.set(item.url, ctx ? await this.pin(ctx, ref).catch(() => null) : null);
      }
    }
    return rewriteEmbedGroups(markdown, (group) =>
      embedGroupMarkup({
        ...group,
        items: group.items.map((item) => {
          const pinned = item.version ? null : versions.get(item.url);
          return pinned ? { ...item, version: pinned.version, caption: item.caption || pinned.name || '' } : item;
        }),
      }),
    );
  }

  /** The file's current version and the item's name. */
  async pin(ctx: ConnectorContext, ref: Pick<EmbedRef, 'fileKey' | 'nodeId'>): Promise<{ version: string; name: string | null }> {
    if (!ref.nodeId) {
      const { file } = await figmaGet<{ file: { name?: string; version?: string } }>(ctx, `/v1/files/${ref.fileKey}/meta`);
      if (!file.version) throw new Error(`Figma reported no version for ${ref.fileKey}`);
      return { version: file.version, name: file.name ?? null };
    }
    const res = await figmaGet<{ version: string; nodes?: Record<string, { document?: { name?: string } } | null> }>(
      ctx,
      `/v1/files/${ref.fileKey}/nodes`,
      { ids: ref.nodeId, depth: '1' },
    );
    return { version: res.version, name: res.nodes?.[ref.nodeId]?.document?.name ?? null };
  }

  /** A call context for this file's connector, or null when no allowlist reaches it. */
  async contextFor(workspaceId: string, fileKey: string): Promise<ConnectorContext | null> {
    const connector = await this.connectorFor(workspaceId, fileKey);
    return connector ? this.connectors.contextFor(connector, async () => undefined) : null;
  }

  private enabledConnectors(workspaceId: string): Promise<Connector[]> {
    return this.prisma.connector.findMany({ where: { workspaceId, kind: 'figma', enabled: true }, orderBy: { createdAt: 'asc' } });
  }

  /** Re-list one connector's allowlist into `embed_files`; null when Figma refused (its rows stay). */
  private async refresh(connector: Connector) {
    const ctx = await this.connectors.contextFor(connector, async () => undefined);
    const files = await figmaAllowedFiles(ctx).catch((err: unknown) => {
      this.logger.warn(`Figma allowlist of connector ${connector.id} could not be listed: ${(err as Error).message}`);
      return null;
    });
    if (!files) return null;
    const workspaceId = connector.workspaceId;
    // The listing is the truth for this connector: rows it no longer reaches go.
    await this.prisma.$transaction([
      this.prisma.embedFile.deleteMany({ where: { connectorId: connector.id, fileKey: { notIn: files.map((f) => f.fileKey) } } }),
      ...files.map((f) =>
        this.prisma.embedFile.upsert({
          where: { workspaceId_provider_fileKey: { workspaceId, provider: 'figma', fileKey: f.fileKey } },
          create: { workspaceId, provider: 'figma', ...f, connectorId: connector.id },
          update: { name: f.name, projectId: f.projectId, teamId: f.teamId, connectorId: connector.id, checkedAt: new Date() },
        }),
      ),
    ]);
    return files;
  }
}

interface FigmaChild {
  id: string;
  name: string;
  type: string;
  children?: FigmaChild[];
}
