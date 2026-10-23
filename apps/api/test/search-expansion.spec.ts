import { describe, expect, it } from 'vitest';
import { HUB_ENTITY_PAGES } from '../src/agents/communities.js';
import { layerParents } from '../src/graph/layers.js';
import { flatFollow, layeredFollow, walkRelated } from '../src/search/expansion.js';

/**
 * Hybrid expansion (#475, docs/features/63): the flat walk crosses every
 * shared key, as before; the layered walk crosses only keys within a rung of
 * the page's own layer, plus membership and `concept` keys, under the hub cut.
 */

const edge = (documentId: string, targetKey: string, extractor = 'frontmatter', type = 'RELATED_TO') => ({
  type,
  documentId,
  targetKey,
  extractor,
  confidence: 1,
});

// A page about one operation (an `interface` page), and what it could reach.
const edges = [
  edge('op-page', 'op:post /invoices'),
  edge('op-page', 'service:billing'),
  edge('op-page', 'tag:invoices'),
  // Shares only the broad service key with the hit.
  edge('svc-sibling', 'service:billing'),
  edge('svc-sibling', 'op:get /refunds'),
  // The spec declaring the operation, under the component it names.
  edge('spec', 'op:post /invoices', 'spec', 'DESCRIBES'),
  edge('spec', 'component:invoicing'),
  // A page about the component, which the hit never names.
  edge('component-page', 'component:invoicing'),
  // A page sharing a tag: concept keys cut across layers.
  edge('tagged', 'tag:invoices'),
  // A tag on more pages than the hub cut allows.
  ...Array.from({ length: HUB_ENTITY_PAGES + 1 }, (_, i) => edge(i ? `hub-${i}` : 'op-page', 'tag:common')),
];
const documents = Object.fromEntries([...new Set(edges.map((e) => e.documentId))].map((id) => [id, { title: id }]));
const reached = (follow: (docId: string) => string[], depth = 1) =>
  walkRelated({ edges, documents }, new Set(['op-page']), depth, follow).map((r) => r.documentId).sort();

describe('walkRelated', () => {
  it('flat: crosses every shared key, the service and the hub included', () => {
    const out = reached(flatFollow(edges));
    expect(out).toContain('svc-sibling');
    expect(out).toContain('hub-1');
    expect(out).not.toContain('component-page');
  });

  it('layered: an operation hit reaches nothing only a service key links (#475 AC)', () => {
    const out = reached(layeredFollow(edges, layerParents(edges, new Map())));
    expect(out).not.toContain('svc-sibling');
    expect(out).toEqual(['component-page', 'spec', 'tagged']);
  });

  it("layered: membership takes an operation to its spec's component, and the hub cut holds at every layer", () => {
    const parents = layerParents(edges, new Map());
    expect(parents.get('op:post /invoices')).toEqual(new Set(['component:invoicing']));
    const related = walkRelated({ edges, documents }, new Set(['op-page']), 1, layeredFollow(edges, parents));
    expect(related.find((r) => r.documentId === 'component-page')!.via).toEqual([
      { entityKey: 'component:invoicing', relationType: 'RELATED_TO', confidence: 1 },
    ]);
    expect(related.some((r) => r.documentId.startsWith('hub-'))).toBe(false);
  });

  it('layered: a page with only concept keys walks every rung', () => {
    const conceptHit = walkRelated({ edges, documents }, new Set(['tagged']), 1, layeredFollow(edges, new Map()));
    expect(conceptHit.map((r) => r.documentId)).toEqual(['op-page']);
  });
});
