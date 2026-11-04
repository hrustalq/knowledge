import { describe, expect, it, vi } from 'vitest';
import { ConnectorDiscoveryService } from '../src/connectors/connector-discovery.service.js';

describe('a scoped run', () => {
  it('holds exactly its scope, and reports nothing to nest or repair (#765)', async () => {
    const items: string[] = [];
    const prisma = {
      connectorRunItem: {
        create: vi.fn(async ({ data }: { data: { externalId: string } }) => {
          items.push(data.externalId);
          return { id: data.externalId };
        }),
        count: vi.fn(async () => items.length),
      },
      connectorRun: { update: vi.fn(async () => undefined) },
    };
    const discovery = new ConnectorDiscoveryService(prisma as never, { get: () => 1000 } as never);
    const adapter = { children: vi.fn(), list: vi.fn() };

    const outcome = await discovery.step({} as never, { id: 'run1', scope: ['page-1'] } as never, adapter as never, {} as never, 10);

    expect(items).toEqual(['page-1']);
    expect(outcome).toMatchObject({ done: true, discovered: 1, incremental: true });
    expect(adapter.list).not.toHaveBeenCalled();
  });
});
