import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { GithubController } from '../src/connectors/github/github.controller.js';
import { FigmaOauthController } from '../src/embeds/figma-oauth.controller.js';
import { PlaudController } from '../src/plaud/plaud.controller.js';

/**
 * #1095: a connection's OAuth callback stores the grant for whoever the signed
 * `state` names. Without a tie to the browser, someone could send their own
 * authorization link to a colleague, and the colleague's approval would land
 * as the sender's credential (for Plaud: the colleague's recordings imported
 * as the sender's memos). The callback now completes only in a browser signed
 * in as the person who started the flow, and stores nothing otherwise.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const STARTER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001';
const STATE = { workspaceId: WS, userId: STARTER, returnTo: '/settings/connectors' };

const tokenAuth = {
  resolveSessionCookie: vi.fn(async (token: string) => {
    if (token === 'ks_starter') return { userId: STARTER };
    if (token === 'ks_colleague') return { userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002' };
    throw new UnauthorizedException('invalid session');
  }),
};
const config = { get: () => 'https://web.example.test' };
const browser = (session?: string) => ({ headers: session ? { cookie: `kn_token=${session}` } : {} });

function providers() {
  const complete = vi.fn(async () => 'connected' as const);
  const github = new GithubController(
    {} as never,
    { verify: () => STATE, completeAuthorization: complete, redirectUri: () => 'https://api.example.test/v1/connectors/github/callback' } as never,
    {} as never,
    config as never,
    {} as never,
    tokenAuth as never,
  );
  const figma = new FigmaOauthController({ verify: () => STATE, completeAuthorization: complete } as never, {} as never, config as never, tokenAuth as never);
  const ensure = vi.fn(async () => undefined);
  const plaud = new PlaudController({ verify: () => STATE, completeAuthorization: complete } as never, { ensure } as never, config as never, tokenAuth as never);
  const calls = {
    github: (req: object, res: object) => github.callback(req as never, res as never, 'signed', 'code'),
    figma: (req: object, res: object) => figma.callback(req as never, res as never, 'signed', 'code'),
    plaud: (req: object, res: object) => plaud.callback(req as never, res as never, 'signed', 'code'),
  };
  return { complete, ensure, calls };
}

describe.each(['github', 'figma', 'plaud'] as const)('%s OAuth callback (#1095)', (name) => {
  it.each([
    ['no session', undefined],
    ["a colleague's session", 'ks_colleague'],
    ['a dead session', 'ks_revoked'],
  ])('with %s, lands on outcome=error and stores nothing', async (_label, session) => {
    const { complete, ensure, calls } = providers();
    const res = { redirect: vi.fn() };
    await calls[name](browser(session), res);
    expect(complete).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(res.redirect.mock.calls[0]![0]).toContain('outcome=error');
  });

  it("completes in the starter's own browser", async () => {
    const { complete, calls } = providers();
    const res = { redirect: vi.fn() };
    await calls[name](browser('ks_starter'), res);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.redirect.mock.calls[0]![0]).not.toContain('outcome=error');
  });
});
