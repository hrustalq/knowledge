export const EXPORT_QUEUE = 'export';

export interface ExportQueueJob {
  exportId: string;
}

/** `workspaces/{ws}/exports/{id}/` — every object one export writes sits under it. */
export function exportObjectPrefix(workspaceId: string, exportId: string): string {
  return `workspaces/${workspaceId}/exports/${exportId}/`;
}
