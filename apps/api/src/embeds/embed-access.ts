import type { Connector, EmbedFile } from '@prisma/client';
import { FIGMA_ALLOWLIST_CONFIG_KEY, parseFigmaAllowlist } from '@knowledge/contracts';

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
