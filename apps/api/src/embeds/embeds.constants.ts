import { createHash } from 'node:crypto';

export const EMBEDS_QUEUE = 'embeds';

/** One pinned item to render. Content-addressed: every page that pins it shares the job and the bytes. */
export interface EmbedSnapshotJob {
  workspaceId: string;
  fileKey: string;
  /** '' for a whole-file item. */
  nodeId: string;
  version: string;
}

/** BullMQ refuses `:` in a custom job id, and a node id carries one. */
export function embedJobId(job: EmbedSnapshotJob): string {
  return createHash('sha1').update(`${job.workspaceId}/${job.fileKey}/${job.nodeId}/${job.version}`).digest('hex');
}

/** `workspaces/{ws}/embeds/figma/{fileKey}/{nodeId}/{version}.png`; `_` for a whole file. */
export function embedSnapshotKey(job: EmbedSnapshotJob): string {
  return `workspaces/${job.workspaceId}/embeds/figma/${job.fileKey}/${job.nodeId.replace(/[:;]/g, '-') || '_'}/${job.version}.png`;
}
