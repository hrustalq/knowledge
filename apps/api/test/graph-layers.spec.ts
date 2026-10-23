import { describe, expect, it } from 'vitest';
import { ENTITY_LAYER_PREFIXES, entityLayerFor, entityTypesOfLayer, layerRung, pageLayerOf } from '@knowledge/contracts';
import { layerParents } from '../src/graph/layers.js';

/** Abstraction layers (#475, phase 3, docs/features/63): derived from the key, never stored. */

describe('entityLayerFor', () => {
  it.each([
    ['service:billing', 'system'],
    ['integration:oms-1c', 'system'],
    ['component:invoice-renderer', 'component'],
    ['db:orders', 'component'],
    ['op:post /invoices/{}', 'interface'],
    ['channel:invoice.paid', 'interface'],
    ['module:apps/api/src', 'code'],
    ['function:function_close', 'code'],
    ['tag:billing', 'concept'],
    ['team:payments', 'concept'],
    ['widget:anything', 'concept'],
    ['bare-key', 'concept'],
  ])('%s → %s', (key, layer) => {
    expect(entityLayerFor(key)).toBe(layer);
  });

  it('inverts: every listed prefix classifies to its own rung, concept has no list', () => {
    for (const [layer, prefixes] of Object.entries(ENTITY_LAYER_PREFIXES)) {
      expect(entityTypesOfLayer(layer as never)).toEqual(prefixes);
      for (const p of prefixes) expect(entityLayerFor(`${p}:x`)).toBe(layer);
    }
    expect(entityTypesOfLayer('concept')).toBeNull();
    expect(new Set(Object.values(ENTITY_LAYER_PREFIXES).flat()).size).toBe(Object.values(ENTITY_LAYER_PREFIXES).flat().length);
  });

  it('orders the rungs coarse to fine, concept off the ladder', () => {
    expect(['system', 'component', 'interface', 'code', 'concept'].map((l) => layerRung(l as never))).toEqual([0, 1, 2, 3, null]);
  });
});

describe('pageLayerOf', () => {
  it('takes the rung with most entities, a tie to the finer one', () => {
    expect(pageLayerOf(['op:get /a', 'service:billing'])).toBe('interface');
    expect(pageLayerOf(['service:billing', 'service:ledger', 'op:get /a'])).toBe('system');
    expect(pageLayerOf(['op:get /a', 'tag:x', 'tag:y', 'tag:z'])).toBe('interface');
  });

  it('is concept when nothing is on the ladder, and null without entities', () => {
    expect(pageLayerOf(['tag:x', 'team:y'])).toBe('concept');
    expect(pageLayerOf([])).toBeNull();
  });
});

describe('layerParents', () => {
  const edge = (documentId: string, targetKey: string, extractor = 'frontmatter', type = 'RELATED_TO') => ({
    type,
    documentId,
    targetKey,
    extractor,
    confidence: 1,
  });

  it('gives a declared component the services its own page names', () => {
    const parents = layerParents(
      [edge('comp-page', 'component:renderer'), edge('comp-page', 'service:billing'), edge('comp-page', 'tag:x')],
      new Map([['comp-page', 'component:renderer']]),
    );
    expect([...parents]).toEqual([['component:renderer', new Set(['service:billing'])]]);
  });

  it("gives a spec's operations the page's components, or failing those its services", () => {
    const withComponent = layerParents(
      [
        edge('spec', 'op:get /invoices', 'spec', 'DESCRIBES'),
        edge('spec', 'component:invoicing'),
        edge('spec', 'service:billing'),
      ],
      new Map(),
    );
    expect(withComponent.get('op:get /invoices')).toEqual(new Set(['component:invoicing']));
    const serviceOnly = layerParents([edge('spec', 'op:get /invoices', 'spec', 'DESCRIBES'), edge('spec', 'service:billing')], new Map());
    expect(serviceOnly.get('op:get /invoices')).toEqual(new Set(['service:billing']));
  });

  it('links nothing from a page that merely mentions two keys', () => {
    expect(layerParents([edge('p', 'op:get /a'), edge('p', 'component:c'), edge('p', 'service:s')], new Map()).size).toBe(0);
  });
});
