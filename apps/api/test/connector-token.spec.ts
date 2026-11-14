import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

/**
 * A connector's pasted token lives only on its connection's credential (#857,
 * phase 4): an update that does not send one keeps dialing with it, and
 * `null` unbinds. No network: the SSRF guard is stubbed.
 */
vi.mock('../src/common/safe-url.js', () => ({ assertSafeExternalUrl: vi.fn(async () => undefined) }));
const { encryptSecret, decryptSecret } = await import('../src/ai/secret-box.js');
const { slots } = await import('../src/ai/secret-slots.js');
const { ConnectorsService } = await import('../src/connectors/connectors.service.js');

const WS = '11111111-1111-4111-8111-111111111111';
const key = randomBytes(32);

function setup() {
  let seq = 0;
  const credentials = [{ id: 'cred-1', userId: null, provider: 'github', method: 'token', site: null, secret: encryptSecret('ghp_x', key, slots.credential({ id: 'cred-1' }, 'secret')), secretHint: '…p_x' }];
  const connections: Array<Record<string, unknown>> = [{ id: 'cx-1', workspaceId: WS, provider: 'github', site: null, method: 'token', credentialId: 'cred-1', createdAt: new Date(0) }];
  const row: Record<string, unknown> = {
    id: 'k-1',
    workspaceId: WS,
    kind: 'markdown-git',
    name: 'Runbooks',
    config: { repoUrl: 'https://github.com/acme/runbooks' },
    connectionId: 'cx-1',
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const withCredential = (c: Record<string, unknown>) => ({ ...c, credentialRow: credentials.find((r) => r.id === c.credentialId) ?? null });
  const matches = (r: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => (r[k] ?? null) === v);
  const prisma = {
    connector: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data)),
    },
    connection: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const c = connections.find((r) => r.id === where.id);
        return c ? withCredential(c) : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => connections.filter((c) => matches(c, where)).map(withCredential)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const c = { ...data, id: `cx-${++seq + 1}`, createdAt: new Date() };
        connections.push(c);
        return c;
      }),
    },
    credential: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => credentials.filter((c) => matches(c, where))),
      create: vi.fn(async ({ data }: { data: (typeof credentials)[number] }) => {
        const c = { id: `cred-${++seq + 1}`, ...data };
        credentials.push(c);
        return c;
      }),
    },
    connectorLink: { count: vi.fn(async () => 0) },
    connectorRun: { findFirst: vi.fn(async () => null) },
  };
  const settings: Record<string, unknown> = { SETTINGS_ENCRYPTION_KEY: key.toString('base64') };
  const service = new ConnectorsService(prisma as never, { get: (k: string) => settings[k] ?? false } as never, {} as never, {} as never, {} as never, {} as never);
  const secretOf = (connectionId: unknown) => {
    const c = connections.find((r) => r.id === connectionId)!;
    return decryptSecret(credentials.find((r) => r.id === c.credentialId)!.secret, key, slots.credential({ id: c.credentialId! }, 'secret'));
  };
  return { service, row, connections, secretOf };
}

describe('a connector update and its token (#857)', () => {
  it('keeps the token across a config change, follows a new host, and unbinds on null', async () => {
    const { service, row, connections, secretOf } = setup();

    const same = await service.update('k-1', { config: { repoUrl: 'https://github.com/acme/other' } });
    expect(same).toMatchObject({ connectionId: 'cx-1', hasCredential: true, credentialHint: '…p_x' });

    await service.update('k-1', { config: { repoUrl: 'https://gitlab.com/acme/runbooks' } });
    expect(row.connectionId).not.toBe('cx-1');
    expect(connections.find((c) => c.id === row.connectionId)).toMatchObject({ provider: 'gitlab', site: 'https://gitlab.com' });
    expect(secretOf(row.connectionId)).toBe('ghp_x');

    const cleared = await service.update('k-1', { credential: null });
    expect(cleared).toMatchObject({ connectionId: null, hasCredential: false, credentialHint: null });
  });
});
