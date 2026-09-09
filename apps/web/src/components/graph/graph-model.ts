/**
 * Shapes and pure helpers shared by the canvas, the control panel and the
 * pages that mount them. Kept out of the component so the projection rules --
 * which are the interesting part -- can be read without wading through a
 * renderer.
 */
import type { DocumentGraphEdge, WorkspaceGraphNode } from '@knowledge/contracts'

export interface GraphNodeInput {
  id: string
  kind: 'document' | 'entity'
  label: string
  category?: string
  entityType?: string
  status?: string | null
  /** Optional: recomputed after filtering anyway, so callers may omit it. */
  degree?: number
  /** Entity hops from a root, when the source was a neighbourhood query. */
  distance?: number
}

export type GraphEdgeInput = Pick<DocumentGraphEdge, 'from' | 'to' | 'type' | 'extractor' | 'confidence'>

export interface GraphOptions {
  /** Off collapses the bipartite graph into page-to-page links via shared entities. */
  showEntities: boolean
  /** Off hides pages nothing links to. They are the reason to look, so: on. */
  showOrphans: boolean
  /** Off leaves only frontmatter/explicit/curated facts — the deterministic set. */
  showInferred: boolean
  /** Entity types (and 'document') the legend has switched off. */
  hidden: string[]
  repel: number
  linkDistance: number
  /** Zoom past which every label is drawn. Below it, only the loud ones. */
  labelZoom: number
}

export const DEFAULT_OPTIONS: GraphOptions = {
  showEntities: true,
  showOrphans: true,
  showInferred: true,
  hidden: [],
  repel: 1,
  linkDistance: 1,
  labelZoom: 0.62,
}

/**
 * The legend/filter key for a node.
 *
 * Pages get a reserved key rather than `'document'`, because `entityType` is
 * free text the extractor writes and this workspace really does contain
 * entities typed `document` — sharing a key would have hidden every page the
 * moment someone switched that entity group off.
 */
export const PAGES_GROUP = '__pages'
export const groupOf = (n: GraphNodeInput) => (n.kind === 'document' ? PAGES_GROUP : (n.entityType ?? 'entity'))

export interface Projection {
  nodes: GraphNodeInput[]
  edges: GraphEdgeInput[]
  /** Group key -> how many nodes carry it, before `hidden` is applied. */
  counts: Record<string, number>
  orphanCount: number
}

/**
 * Apply the filters, then — when entities are hidden — rebuild page-to-page
 * links out of the entities those pages shared.
 *
 * That projection is derived, and the UI says so, because the store holds no
 * page-to-page edge: every link here means "these two pages talk about the same
 * thing", which is a weaker claim than any edge the extractor wrote and must
 * not be mistaken for one.
 */
export function project(nodes: GraphNodeInput[], edges: GraphEdgeInput[], opts: GraphOptions): Projection {
  const counts: Record<string, number> = {}
  for (const n of nodes) counts[groupOf(n)] = (counts[groupOf(n)] ?? 0) + 1

  const hidden = new Set(opts.hidden)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visible = (id: string) => {
    const n = byId.get(id)
    if (!n) return false
    if (n.kind === 'entity' && !opts.showEntities) return false
    return !hidden.has(groupOf(n))
  }

  let kept = edges.filter((e) => (opts.showInferred || e.extractor !== 'inferred') && visible(e.from))

  let outNodes: GraphNodeInput[]
  if (opts.showEntities) {
    kept = kept.filter((e) => visible(e.to))
    outNodes = nodes.filter((n) => visible(n.id))
  } else {
    // Group page ids by the entity they share, then link every pair in a group.
    const byEntity = new Map<string, string[]>()
    for (const e of kept) {
      const bucket = byEntity.get(e.to)
      if (bucket) bucket.push(e.from)
      else byEntity.set(e.to, [e.from])
    }
    const pairs = new Map<string, GraphEdgeInput & { shared: number }>()
    for (const [, docs] of byEntity) {
      const uniq = [...new Set(docs)]
      // A hub entity mentioned by thirty pages would otherwise contribute 435
      // links that say nothing except "this is a common word".
      if (uniq.length > 12) continue
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const a = uniq[i]!
          const b = uniq[j]!
          const key = a < b ? `${a} ${b}` : `${b} ${a}`
          const found = pairs.get(key)
          if (found) found.shared += 1
          else pairs.set(key, { from: a, to: b, type: 'SHARES', extractor: 'derived', confidence: 1, shared: 1 })
        }
      }
    }
    kept = [...pairs.values()]
    outNodes = nodes.filter((n) => n.kind === 'document' && visible(n.id))
  }

  const degree = new Map<string, number>()
  for (const e of kept) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }
  const orphanCount = outNodes.filter((n) => !degree.get(n.id)).length
  if (!opts.showOrphans) outNodes = outNodes.filter((n) => degree.get(n.id))

  const present = new Set(outNodes.map((n) => n.id))
  kept = kept.filter((e) => present.has(e.from) && present.has(e.to))

  return {
    nodes: outNodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })),
    edges: kept,
    counts,
    orphanCount,
  }
}

/** Node radius in world units. Degree is the hierarchy; scale is how it reads. */
export function radiusOf(n: GraphNodeInput, isRoot: boolean): number {
  const d = n.degree ?? 0
  if (n.kind === 'document') {
    // sqrt keeps a 40-link hub from dwarfing a 4-link page by ten times.
    const r = 5.5 + Math.sqrt(d) * 2.6
    return isRoot ? Math.max(r, 11) * 1.25 : Math.min(r, 21)
  }
  return Math.min(3 + Math.sqrt(d) * 1.5, 10)
}

export function toGraphNodes(nodes: WorkspaceGraphNode[]): GraphNodeInput[] {
  return nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    category: n.category,
    entityType: n.entityType,
    status: n.status ?? null,
    degree: n.degree,
  }))
}
