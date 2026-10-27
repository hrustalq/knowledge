import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.js';
import type { Principal } from '../src/auth/principal.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { GithubAppService } from '../src/connectors/github/github-app.service.js';
import type { GithubBrowseService } from '../src/connectors/github/github-browse.service.js';
import { GithubController } from '../src/connectors/github/github.controller.js';
import { GithubOauthService } from '../src/connectors/github/github-oauth.service.js';

/**
 * #552: a deployment with some GitHub App keys but not all used to fall back to
 * the PAT fields silently, indistinguishable from one that chose PAT-only.
 */

const WORKSPACE = '22222222-2222-4222-8222-222222222222';

function installations(env: Partial<Record<keyof Env, string>>) {
  const config = { get: (key: keyof Env) => env[key] ?? '' } as unknown as ConfigService<Env, true>;
  const controller = new GithubController(
    new GithubAppService(config),
    new GithubOauthService(config, {} as PrismaService),
    {} as GithubBrowseService,
    config,
  );
  return controller.installations(WORKSPACE, { userId: 'u' } as Principal);
}

describe('GET /v1/connectors/github/installations, not configured', () => {
  it('stays silent when every picker key is empty — the supported off state', async () => {
    const res = await installations({
      SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      GITHUB_APP_WEBHOOK_SECRET: 'trackers-use-this-alone',
    });
    expect(res.configured).toBe(false);
    expect(res.missing).toBeUndefined();
  });

  it('names every missing key when only the App id is set', async () => {
    const res = await installations({ GITHUB_APP_ID: '123' });
    expect(res.configured).toBe(false);
    expect(res.missing).toEqual([
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'SETTINGS_ENCRYPTION_KEY',
    ]);
  });

  it('names only the private key when that is all production lacks', async () => {
    const res = await installations({
      GITHUB_APP_ID: '123',
      GITHUB_APP_SLUG: 'knowledge',
      GITHUB_APP_CLIENT_ID: 'Iv1.x',
      GITHUB_APP_CLIENT_SECRET: 's',
      SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    expect(res.missing).toEqual(['GITHUB_APP_PRIVATE_KEY']);
  });
});

describe('the GitHub callback lands on /oauth/github (#564)', () => {
  const env = { SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString('base64'), WEB_BASE_URL: 'https://kb.test/' };
  const config = { get: (key: keyof Env) => (env as Record<string, string>)[key] ?? '' } as unknown as ConfigService<Env, true>;

  it('sends a forged state to the error outcome, and an install to `installed` with the signed return path', async () => {
    const oauth = new GithubOauthService(config, {} as PrismaService);
    const recorded: string[] = [];
    const browse = { recordInstallation: async (_ws: string, id: string) => (recorded.push(id), true) } as unknown as GithubBrowseService;
    const controller = new GithubController(new GithubAppService(config), oauth, browse, config);
    const redirect = (url: string) => urls.push(url);
    const urls: string[] = [];

    await controller.callback({ redirect } as never, 'forged');
    const state = oauth.sign(WORKSPACE, 'u', '/projects/p1')!;
    await controller.callback({ redirect } as never, state, undefined, '42');

    expect(recorded).toEqual(['42']);
    expect(urls).toEqual([
      'https://kb.test/oauth/github?outcome=error',
      'https://kb.test/oauth/github?outcome=installed&returnTo=%2Fprojects%2Fp1',
    ]);
  });
});
