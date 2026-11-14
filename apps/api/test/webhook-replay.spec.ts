import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { GithubWebhookController } from '../src/connectors/github/github-webhook.controller.js';
import { ConnectorWebhookController } from '../src/connectors/connector-webhook.controller.js';
import { WebhookReplay } from '../src/connectors/webhook-replay.js';

/**
 * #1143: GitHub and repo hooks sign the body but stamp no time, so a captured
 * delivery verifies forever. Each signed body is acted on once.
 */

function redis() {
  const data = new Map<string, string>();
  return {
    data,
    kv: {
      set: vi.fn(async (k: string, v: string, _m: string, _ms: number, nx?: string) => {
        if (nx === 'NX' && data.has(k)) return null;
        data.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (k: string) => Number(data.delete(k))),
    },
  };
}

const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const req = (body: string) => ({ rawBody: Buffer.from(body) }) as never;

describe('GitHub App webhook replay (#1143)', () => {
  const secret = 'app-secret';
  function controller(store = redis()) {
    const row = { id: 'c1', workspaceId: 'w1', kind: 'github', enabled: true, config: {} };
    const workItems = { applyDelivery: vi.fn(async () => undefined) };
    const ctl = new GithubWebhookController(
      { get: () => secret } as never,
      { forGithubDelivery: vi.fn(async () => [row]) } as never,
      workItems as never,
      {} as never,
      {} as never,
      {} as never,
      new WebhookReplay(store as never),
    );
    return { ctl, workItems, store };
  }
  const body = JSON.stringify({
    action: 'opened',
    installation: { id: 7 },
    repository: { full_name: 'o/r' },
    issue: { number: 1, title: 't', state: 'open', html_url: 'https://x', user: { login: 'a' }, assignees: [], labels: [] },
  });

  it('acts on a signed delivery once, however often it is sent', async () => {
    const { ctl, workItems } = controller();
    const headers = { 'x-github-event': 'issues', 'x-hub-signature-256': sign(body, secret), 'x-github-delivery': 'd1' };
    expect(await ctl.receive(headers, req(body))).toEqual({ accepted: true, handled: 1 });
    // The delivery id is not signed: a new one on the same body is still a replay.
    expect(await ctl.receive({ ...headers, 'x-github-delivery': 'd2' }, req(body))).toEqual({ accepted: true, handled: 0 });
    expect(workItems.applyDelivery).toHaveBeenCalledTimes(1);
  });

  it('remembers nothing for a delivery whose signature fails', async () => {
    const { ctl, store } = controller();
    await expect(ctl.receive({ 'x-github-event': 'issues', 'x-hub-signature-256': sign(body, 'wrong') }, req(body))).rejects.toMatchObject({ status: 401 });
    expect(store.data.size).toBe(0);
  });

  it('passes deliveries through when Redis is down', async () => {
    const down = { kv: { set: vi.fn(async () => Promise.reject(new Error('down'))), del: vi.fn() } };
    const { ctl, workItems } = controller(down as never);
    const headers = { 'x-github-event': 'issues', 'x-hub-signature-256': sign(body, secret) };
    await ctl.receive(headers, req(body));
    await ctl.receive(headers, req(body));
    expect(workItems.applyDelivery).toHaveBeenCalledTimes(2);
  });
});

describe('per-connector repo webhook replay (#1143)', () => {
  it('queues a drift check for a signed pull-request delivery once, and forgets a refused one', async () => {
    const store = redis();
    const row = { id: 'c2', workspaceId: 'w1', kind: 'codebase', enabled: true, webhookSecret: 'sealed', config: {} };
    const ctx = { webhookSecret: 'repo-secret' };
    const drift = { request: vi.fn(async () => 'run-1'), merged: vi.fn() };
    const ctl = new ConnectorWebhookController(
      { require: vi.fn(async () => row), webhookContextFor: () => ctx, adapterFor: () => ({}) } as never,
      { enqueue: vi.fn() } as never,
      drift as never,
      { trackerFor: () => null } as never,
      {} as never,
      {} as never,
      { get: () => 0 } as never,
      new WebhookReplay(store as never),
    );
    const body = JSON.stringify({
      action: 'synchronize',
      number: 5,
      pull_request: { number: 5, state: 'open', title: 'x', html_url: 'https://x', head: { sha: 'abc', ref: 'f', repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } }, user: { login: 'a' } },
      repository: { full_name: 'o/r' },
    });
    const headers = { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body, 'repo-secret') };
    await expect(ctl.receive(row.id, { ...headers, 'x-hub-signature-256': sign(body, 'nope') }, req(body))).rejects.toMatchObject({ status: 401 });
    expect(store.data.size).toBe(0);
    const first = await ctl.receive(row.id, headers, req(body));
    const again = await ctl.receive(row.id, headers, req(body));
    expect(first).toEqual({ accepted: true, runId: 'run-1' });
    expect(again).toEqual({ accepted: true, runId: null });
    expect(drift.request).toHaveBeenCalledTimes(1);
  });
});
