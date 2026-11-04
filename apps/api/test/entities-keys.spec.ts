import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { EntitiesService } from '../src/entities/entities.service.js';
import { EntityAliasService } from '../src/graph/entity-alias.service.js';

const WS = '11111111-1111-4111-8111-111111111111';

/** #756: a read folds and alias-resolves a key the way a write does. */
describe('entity reads', () => {
  const edge = (targetKey: string) => ({
    documentId: 'd1',
    targetKey,
    type: 'RELATED_TO',
    extractor: 'frontmatter',
    confidence: 1,
  });
  const graph = {
    documents: { d1: { title: 'Billing' } },
    entities: {
      'service:billing': { type: 'service', name: 'billing' },
      'service:auth': { type: 'service', name: 'auth' },
      // An alias declared after a page used it keeps its own vertex.
      'legacy:pay': { type: 'legacy', name: 'pay' },
    },
    edges: [edge('service:billing'), edge('service:auth'), edge('legacy:pay')],
  };
  const prisma = {
    entityAlias: {
      findMany: async () => [
        { alias: 'сервис:биллинг', canonicalKey: 'service:billing' },
        { alias: 'legacy:pay', canonicalKey: 'service:missing' },
      ],
    },
  };
  const svc = new EntitiesService(
    { getWorkspaceRelationGraph: async () => graph } as never,
    { documentFilterFor: async () => ({}) } as never,
    new EntityAliasService(prisma as never),
  );
  const scope = { workspaceId: WS } as never;

  it.each(['service:billing', 'Service:Billing', '  SERVICE:billing', 'сервис:биллинг', 'Сервис:Биллинг'])(
    'neighbors of %s answer with the canonical key',
    async (key) => {
      const out = await svc.neighbors(scope, key);
      expect(out.entity.key).toBe('service:billing');
      expect(out.edges.map((e) => e.entityKey)).toEqual(['service:billing']);
      expect(out.relatedEntities.map((e) => e.key)).toContain('service:auth');
    },
  );

  it('resolves impact analysis and trace the same way', async () => {
    expect((await svc.impactAnalysis(scope, 'Сервис:Биллинг')).entity.key).toBe('service:billing');
    const path = await svc.trace(scope, 'Service:Billing', 'SERVICE:AUTH');
    expect(path).toMatchObject({ from: 'service:billing', to: 'service:auth', hops: 1 });
  });

  it('falls back to the vertex an alias still has, and 404s an unknown key', async () => {
    expect((await svc.neighbors(scope, 'Legacy:Pay')).entity.key).toBe('legacy:pay');
    await expect(svc.neighbors(scope, 'service:nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
