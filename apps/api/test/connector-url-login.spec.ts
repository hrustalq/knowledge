import { describe, expect, it, vi } from 'vitest';
import { ConnectorsService } from '../src/connectors/connectors.service.js';
import { systemScope } from '../src/permissions/access-scope.js';
import { stripUrlLogins } from '../src/connectors/url-login.js';

/**
 * #1142: since #1138 a connector URL with a login is refused at save, but a row
 * saved before keeps it, and the list handed the token to every viewer.
 */
const WS = '11111111-1111-4111-8111-111111111111';
const at = { createdAt: new Date(0), updatedAt: new Date(0), lastSyncedAt: null };

describe('stripUrlLogins', () => {
  it('drops the userinfo of every URL-shaped value and leaves the rest', () => {
    expect(
      stripUrlLogins({
        repoUrl: 'https://x-access-token:ghp_secret@github.com/acme/docs.git',
        baseUrl: ' https://user:p@ss@wiki.example.com/rest ',
        spaceKey: 'DOCS',
        email: 'ops@example.com',
        plain: 'https://github.com/acme/docs',
        mailto: 'mailto:ops@example.com',
      }),
    ).toEqual({
      repoUrl: 'https://github.com/acme/docs.git',
      baseUrl: 'https://wiki.example.com/rest',
      spaceKey: 'DOCS',
      email: 'ops@example.com',
      plain: 'https://github.com/acme/docs',
      mailto: 'mailto:ops@example.com',
    });
  });
});

describe('GET /v1/connectors', () => {
  it('never returns a stored URL login', async () => {
    const prisma = {
      connector: {
        findMany: vi.fn(async () => [
          {
            id: 'c1',
            workspaceId: WS,
            projectId: 'p1',
            project: { id: 'p1', restricted: false },
            kind: 'git',
            name: 'Docs',
            enabled: true,
            connectionId: null,
            webhookSecret: null,
            config: { repoUrl: 'https://x-access-token:ghp_secret@github.com/acme/docs.git', branch: 'main' },
            ...at,
          },
        ]),
      },
      connectorLink: { count: vi.fn(async () => 0) },
      connectorRun: { findFirst: vi.fn(async () => null) },
    };
    const service = new ConnectorsService(prisma as never, { get: () => undefined } as never, {} as never, {} as never, {} as never, {} as never);
    const [summary] = await service.list(systemScope(WS));
    expect(summary.config).toEqual({ repoUrl: 'https://github.com/acme/docs.git', branch: 'main' });
    expect(JSON.stringify(summary)).not.toContain('ghp_secret');
  });
});
