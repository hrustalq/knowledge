import type { Connector, EmbedFile } from '@prisma/client';
import { FIGMA_ALLOWLIST_CONFIG_KEY, parseFigmaAllowlist, UUID_RE } from '@knowledge/contracts';

/**
 * The one read-time access rule for an embedded file (#470, docs/features/64):
 * its connector is enabled and still lists the file's project or team. Checked
 * on every snapshot read, so removing an allowlist entry or disabling the
 * connector hides the snapshot everywhere, old revisions included, and adding
 * it back restores it — the bytes never left storage.
 */
export function embedFileAllowed(file: Pick<EmbedFile, 'projectId' | 'teamId'>, connector: Pick<Connector, 'enabled' | 'kind' | 'config'> | null | undefined): boolean {
  if (!connector?.enabled || connector.kind !== 'figma') return false;
  const allowlist = parseFigmaAllowlist(String((connector.config as Record<string, unknown>)?.[FIGMA_ALLOWLIST_CONFIG_KEY] ?? ''));
  return allowlist.projects.includes(file.projectId) || (!!file.teamId && allowlist.teams.includes(file.teamId));
}

/**
 * The snapshot URL a public route (a site, a share link) serves for one embed
 * item, or null for anything it must 404: a malformed id, an item with no
 * pinned frame, a page `readable` refuses, or a snapshot the embed service
 * will not hand out. The caller checks `allow_public_embeds` first.
 */
export async function publicEmbedUrl(
  // EmbedsService's two methods, spelled out: importing its type would close a cycle with it.
  embeds: {
    publicItem(id: string): Promise<{ documentId: string; revisionId: string; fileKey: string | null; nodeId: string | null; version: string | null } | null>;
    snapshotUrl(documentId: string, key: { fileKey: string; nodeId: string; version: string }): Promise<string>;
  },
  itemId: string,
  readable: (item: { documentId: string; revisionId: string }) => Promise<boolean>,
): Promise<string | null> {
  const item = UUID_RE.test(itemId) ? await embeds.publicItem(itemId) : null;
  if (!item?.fileKey || !item.version || item.nodeId === null || !(await readable(item))) return null;
  return embeds.snapshotUrl(item.documentId, { fileKey: item.fileKey, nodeId: item.nodeId, version: item.version }).catch(() => null);
}
