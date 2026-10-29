import { reactive, type InjectionKey } from 'vue'
import type { PublicSiteTreeNode } from '@knowledge/contracts'

/**
 * The reader's nav tree (issue #204): what is loaded, what is open, what is
 * loading. The public app has no Pinia, so this is a plain reactive object
 * the reader creates and hands its rows through `provide`.
 *
 * It starts from what the server rendered — the top level and the children of
 * every page on the open path — and grows a level at a time: opening a branch
 * whose children have not arrived asks `load` for that level and nothing else.
 * A collapsed branch is never fetched.
 */
export interface SiteTree {
  /** Children by parent id (`null` = the top level), for the levels that have arrived. */
  readonly children: Map<string | null, PublicSiteTreeNode[]>
  readonly open: Set<string>
  readonly loading: Set<string>
  /** The current page, and how deep it sits: where the nav opens and where its window looks. */
  readonly activeId: string | null
  readonly activeDepth: number
  toggle(node: PublicSiteTreeNode): Promise<void>
}

export const SiteTreeKey: InjectionKey<SiteTree> = Symbol('kn-site-tree')

/** Nodes grouped by parent, in the order the server sent them (reading order). */
function groupByParent(nodes: PublicSiteTreeNode[]): Map<string | null, PublicSiteTreeNode[]> {
  const out = new Map<string | null, PublicSiteTreeNode[]>()
  for (const n of nodes) out.set(n.parentId, [...(out.get(n.parentId) ?? []), n])
  return out
}

export function createSiteTree(opts: {
  initial: PublicSiteTreeNode[]
  activeId: string | null
  /** One level: the children of `parentId` the viewer may see. */
  load: (parentId: string) => Promise<PublicSiteTreeNode[]>
}): SiteTree {
  const parentOf = new Map(opts.initial.map((n) => [n.documentId, n.parentId]))
  // The open path: the current page and its ancestors. The server sent the
  // children of each of them, so each opens onto rows that are already here.
  const path: string[] = []
  for (let id = opts.activeId; id && parentOf.has(id); id = parentOf.get(id) ?? null) path.push(id)
  const children = groupByParent(opts.initial)

  const tree: SiteTree = reactive({
    children,
    open: new Set(path.filter((id) => children.has(id))),
    loading: new Set<string>(),
    activeId: opts.activeId,
    activeDepth: Math.max(0, path.length - 1),
    async toggle(node: PublicSiteTreeNode) {
      if (tree.open.delete(node.documentId)) return
      // The row opens at once; its placeholders hold the space while the level
      // arrives, so the click never waits on the network to be acknowledged.
      tree.open.add(node.documentId)
      if (tree.children.has(node.documentId) || tree.loading.has(node.documentId)) return
      tree.loading.add(node.documentId)
      try {
        tree.children.set(node.documentId, await opts.load(node.documentId))
      } catch {
        // Nothing to open onto: close it again, and the next click retries.
        tree.open.delete(node.documentId)
      } finally {
        tree.loading.delete(node.documentId)
      }
    },
  }) as SiteTree
  return tree
}
