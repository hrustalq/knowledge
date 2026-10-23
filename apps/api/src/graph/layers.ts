import { entityLayerFor, type EntityLayer } from '@knowledge/contracts';
import type { WorkspaceRelationGraph } from './graph.service.js';

/**
 * Membership between layers (#475, docs/features/63): which coarser entities
 * an entity belongs to. Only a page that declares an entity says, and only
 * from facts the graph already holds:
 *
 * - a component page (`component_declarations`) gives its component the
 *   `system`-rung entities it names;
 * - a spec page's `spec` DESCRIBES edges declare its operations and channels,
 *   which belong to the `component`-rung entities the page names through its
 *   other edges, or failing those to its `system`-rung ones.
 *
 * Nothing else: a `code` edge is usage, and a page that merely mentions two
 * keys links nothing. Derived per read, never stored, and no edge type joins
 * RELATION_EDGE_TYPES. One hop — a walk reads parents and children, never chains.
 */
export function layerParents(
  edges: WorkspaceRelationGraph['edges'],
  /** documentId → the folded `component:` key that page declares. */
  declarations: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const byDoc = new Map<string, WorkspaceRelationGraph['edges']>();
  for (const e of edges) byDoc.set(e.documentId, [...(byDoc.get(e.documentId) ?? []), e]);
  const named = (docId: string, layer: EntityLayer) =>
    (byDoc.get(docId) ?? []).filter((e) => e.extractor !== 'spec' && entityLayerFor(e.targetKey) === layer).map((e) => e.targetKey);

  const parents = new Map<string, Set<string>>();
  const add = (child: string, keys: string[]) => {
    for (const key of keys) {
      if (key === child) continue;
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child)!.add(key);
    }
  };
  for (const [docId, component] of declarations) add(component, named(docId, 'system'));
  for (const [docId, docEdges] of byDoc) {
    const declared = docEdges.filter((e) => e.extractor === 'spec' && e.type === 'DESCRIBES').map((e) => e.targetKey);
    if (declared.length === 0) continue;
    const components = named(docId, 'component');
    const owners = components.length ? components : named(docId, 'system');
    for (const key of declared) add(key, owners);
  }
  return parents;
}
