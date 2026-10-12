import type { PublicShareTreeNode } from '@knowledge/contracts'
import type { Locale } from '@knowledge/contracts'
import type { PublicHeading } from '@/lib/markdown/public-render.server'

/**
 * What one public render hands the browser (docs/features/43). Built on the
 * server by entry-public.ts and hydrated from `window.__KN_PUBLIC__` — the
 * reader never fetches the page again on the client, so this is the whole of
 * what it knows.
 */
export type PublicReaderView =
  | { kind: 'not-found' }
  | { kind: 'locked'; token: string }
  | {
      kind: 'share'
      token: string
      title: string
      tree: PublicShareTreeNode[]
      treeTruncated: boolean
      expiresAt: string | null
      page: {
        documentId: string
        title: string
        /** Sanitized and scope-rewritten on the server. */
        html: string
        headings: PublicHeading[]
        updatedAt: string | null
      }
    }

export interface PublicReaderState {
  locale: Locale
  /** The browser-facing API base (`/api` behind Caddy and the Vite proxy). */
  apiBase: string
  view: PublicReaderView
}

/** The reader URL of a page; the shared page itself is the bare token. */
export function shareHref(token: string, documentId: string | null, rootId: string | null): string {
  return documentId && documentId !== rootId ? `/s/${token}/${documentId}` : `/s/${token}`
}

/** The tree as rows in reading order, each with its depth below the shared page. */
export function treeRows(nodes: PublicShareTreeNode[]): Array<PublicShareTreeNode & { depth: number }> {
  const children = new Map<string | null, PublicShareTreeNode[]>()
  const ids = new Set(nodes.map((n) => n.documentId))
  for (const node of nodes) {
    // A parent cut off by the tree cap would orphan its children; they are
    // dropped rather than shown at the wrong level.
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : node.parentId === null ? null : undefined
    if (parent === undefined) continue
    const list = children.get(parent) ?? []
    list.push(node)
    children.set(parent, list)
  }
  const rows: Array<PublicShareTreeNode & { depth: number }> = []
  const walk = (parent: string | null, depth: number) => {
    const list = (children.get(parent) ?? []).sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
    for (const node of list) {
      rows.push({ ...node, depth })
      walk(node.documentId, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}
