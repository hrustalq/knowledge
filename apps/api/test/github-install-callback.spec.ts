import { describe, expect, it, vi } from 'vitest';
import { GithubBrowseService } from '../src/connectors/github/github-browse.service.js';
import { GithubController } from '../src/connectors/github/github.controller.js';
import { ConnectorsService } from '../src/connectors/connectors.service.js';

/**
 * GHSA-52pw-fwcw-7mmf: the signed `state` proves who started a flow, not that
 * GitHub sent this installation for it. An installation is recorded only when
 * the person's own GitHub account reaches it, the gate `addInstallation`
 * already applied.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const USER = 'user-1';
const STATE = { workspaceId: WS, userId: USER, returnTo: '/settings/connectors' };

function harness(opts: { token: string | null; visible: string[] }) {
  const prisma = {
    githubInstallation: { upsert: vi.fn(async () => ({})) },
    connection: { upsert: vi.fn(async () => ({ id: 'conn-1' })) },
  };
  const app = {
    installation: vi.fn(async (id: string) => ({ installationId: id, accountLogin: 'victim-org', accountType: 'Organization', accountAvatarUrl: null, repositorySelection: 'all', suspended: false })),
  };
  const oauth = {
    verify: vi.fn(() => STATE),
    tokenFor: vi.fn(async () => opts.token),
    completeAuthorization: vi.fn(async () => true),
    redirectUri: () => 'https://api.example.test/v1/connectors/github/callback',
    authorizeUrl: (state: string) => `https://github.com/login/oauth/authorize?state=${state}`,
  };
  const browse = new GithubBrowseService(prisma as never, app as never, oauth as never);
  (browse as unknown as { userInstallations: unknown }).userInstallations = async () => opts.visible.map((installationId) => ({ installationId }));
  const config = { get: () => 'https://web.example.test' };
  // The starter's own browser (#1095): its session cookie names the user the state names.
  const tokenAuth = { resolveSessionCookie: async () => ({ userId: USER }) };
  const controller = new GithubController(app as never, oauth as never, browse, config as never, {} as never, tokenAuth as never);
  const res = { redirect: vi.fn() };
  const req = { headers: { cookie: 'kn_token=ks_starter' } };
  const call = (installationId: string, code?: string) => controller.callback(req as never, res as never, 'signed', code, installationId);
  return { prisma, res, call };
}

describe('GitHub App setup callback', () => {
  it('records nothing for an installation the person cannot reach, and lands on install-failed', async () => {
    const { prisma, res, call } = harness({ token: 'ghu_mine', visible: ['111'] });
    await call('999');
    expect(prisma.githubInstallation.upsert).not.toHaveBeenCalled();
    expect(prisma.connection.upsert).not.toHaveBeenCalled();
    expect(res.redirect.mock.calls[0]![0]).toContain('install-failed');
  });

  it('records an installation the person reaches', async () => {
    const { prisma, res, call } = harness({ token: 'ghu_mine', visible: ['111'] });
    await call('111');
    expect(prisma.connection.upsert).toHaveBeenCalledTimes(1);
    expect(res.redirect.mock.calls[0]![0]).toContain('installed');
  });

  it('defers to the OAuth leg when the person has no GitHub sign-in yet, recording nothing', async () => {
    const { prisma, res, call } = harness({ token: null, visible: [] });
    await call('111');
    expect(prisma.githubInstallation.upsert).not.toHaveBeenCalled();
    expect(res.redirect.mock.calls[0]![0]).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
  });
});

describe('binding a connector to an app connection', () => {
  function service() {
    const prisma = {
      connection: { findUnique: vi.fn(async () => ({ id: 'conn-1', workspaceId: WS, provider: 'github', site: null, method: 'app', externalRef: '999' })) },
    };
    const config = { get: () => false };
    return new ConnectorsService(prisma as never, config as never, {} as never, {} as never, {} as never, {} as never);
  }
  const via = (reach?: (id: string) => Promise<boolean>) =>
    (service() as unknown as { viaConnection: (...a: unknown[]) => Promise<unknown> }).viaConnection(
      WS,
      'codebase',
      'conn-1',
      { repoUrl: 'https://github.com/victim-org/repo' },
      reach,
    );

  it('refuses when the caller cannot reach the installation', async () => {
    await expect(via(async () => false)).rejects.toThrow(/githubNotVisible/);
  });

  it('refuses when no person is there to check', async () => {
    await expect(via()).rejects.toThrow(/githubNotVisible/);
  });

  it('binds when the caller reaches it', async () => {
    await expect(via(async (id) => id === '999')).resolves.toMatchObject({ connectionId: 'conn-1' });
  });
});
