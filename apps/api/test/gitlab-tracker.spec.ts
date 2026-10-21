import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connector } from '@prisma/client';
import { workItemStatusFor, workItemStatusMap } from '@knowledge/contracts';

/**
 * GitLab Issues as a tracker (#424), against recorded GitLab REST shapes
 * through a mocked `safeFetch`: CI, no network. Self-hosted, with a subgroup,
 * because that is where a path built from two segments would break.
 */

vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
const { safeFetch } = await import('../src/common/safe-fetch.js');
const { GitlabTrackerService } = await import('../src/connectors/adapters/gitlab-tracker.js');
const { GithubIssuesService } = await import('../src/connectors/github/github-issues.service.js');
const mockFetch = vi.mocked(safeFetch);

const ORIGIN = 'https://gitlab.acme.io';
const row = {
  id: 'c1',
  kind: 'markdown-git',
  name: 'Docs repo',
  locale: 'en',
  config: { repoUrl: `${ORIGIN}/platform/billing/docs.git` },
} as unknown as Connector;
const ctx = { config: row.config as Record<string, unknown>, credential: 'glpat-x', allowPrivate: false, debug: () => undefined, signal: undefined };
const tracker = new GitlabTrackerService({ contextFor: async () => ctx } as never);
const PROJECT = `${ORIGIN}/api/v4/projects/platform%2Fbilling%2Fdocs`;

function issue(state: 'opened' | 'closed', updated = '2026-10-21T10:00:00.000Z') {
  return {
    id: 9001,
    iid: 45,
    title: 'Knowledge conflict: Runbook ↔ API',
    description: 'Two sources disagree.\n\nknowledge-ref: conflict:11111111-1111-4111-8111-111111111111',
    state,
    web_url: `${ORIGIN}/platform/billing/docs/-/issues/45`,
    author: { username: 'kb-bot' },
    assignees: [],
    labels: ['knowledge'],
    created_at: '2026-10-21T09:00:00.000Z',
    updated_at: updated,
  };
}

type Call = { method: string; url: string; body: any; headers: Record<string, string> };
let calls: Call[];
let reply: (call: Call) => { status?: number; body?: unknown };

beforeEach(() => {
  calls = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> };
    calls.push(call);
    const { status = 200, body } = reply(call);
    return new Response(JSON.stringify(body ?? {}), { status });
  });
});

describe('GitlabTrackerService', () => {
  it('serves GitLab repository connectors, GitHub serves github.com, and neither serves the other', () => {
    const github = new GithubIssuesService({} as never, {} as never);
    expect(tracker.supports(row)).toBe(true);
    expect(github.supports(row)).toBe(false);
    const onGithub = { ...row, config: { repoUrl: 'https://github.com/acme/app' } } as never;
    expect(tracker.supports(onGithub)).toBe(false);
    expect(github.supports(onGithub)).toBe(true);
  });

  it('addresses the project by its whole path and sends the token as PRIVATE-TOKEN', async () => {
    reply = () => ({ body: issue('opened') });
    const got = await tracker.getIssue(row, { number: 45, externalKey: null });
    expect(calls[0].url).toBe(`${PROJECT}/issues/45`);
    expect(calls[0].headers['private-token']).toBe('glpat-x');
    expect(got).toMatchObject({ number: 45, state: 'open', externalStatus: 'opened', authorLogin: 'kb-bot' });
    expect(got!.body).toContain('knowledge-ref: conflict:');
  });

  it('answers null for a ticket that is gone', async () => {
    reply = () => ({ status: 404, body: { message: '404 Not found' } });
    expect(await tracker.getIssue(row, { number: 99, externalKey: null })).toBeNull();
  });

  it('creates with a markdown description and comma-joined labels', async () => {
    reply = () => ({ body: issue('opened') });
    await tracker.createIssue(row, { title: 't', lines: [{ text: 'Two sources disagree.' }, { link: 'https://kb/conflicts', text: 'Open' }], labels: ['knowledge', 'docs'] });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${PROJECT}/issues` });
    expect(calls[0].body).toEqual({ title: 't', description: 'Two sources disagree.\n\n[Open](https://kb/conflicts)', labels: 'knowledge,docs' });
  });

  it('closes and reopens with state_event, and both done and wont_do map to closed', async () => {
    reply = (c) => ({ body: issue(c.body?.state_event === 'close' ? 'closed' : 'opened') });
    const map = workItemStatusMap('gitlab');
    const closed = await tracker.transition(row, { number: 45, externalKey: null }, map.outbound.wont_do!);
    expect(calls[0]).toMatchObject({ method: 'PUT', body: { state_event: 'close' } });
    expect(workItemStatusFor(closed!, map)).toBe('done');
    await tracker.transition(row, { number: 45, externalKey: null }, map.outbound.open!);
    expect(calls[1].body).toEqual({ state_event: 'reopen' });
    await expect(tracker.transition(row, { number: 45, externalKey: null }, 'Done')).rejects.toThrow();
  });

  it('polls updated_after the cursor, oldest first', async () => {
    reply = () => ({ body: [issue('closed', '2026-10-21T12:00:00.000Z')] });
    const { items, cursor } = await tracker.listIssues(row, '2026-10-21T10:00:00.000Z');
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('updated_after')).toBe('2026-10-21T10:00:00.000Z');
    expect(url.searchParams.get('sort')).toBe('asc');
    expect(items[0].state).toBe('closed');
    expect(cursor).toBe('2026-10-21T12:00:00.000Z');
  });

  it('reads refs on this project only', () => {
    expect(tracker.parseRef(row, '#45')).toEqual({ number: 45, externalKey: null });
    expect(tracker.parseRef(row, 'platform/billing/docs#45')).toEqual({ number: 45, externalKey: null });
    expect(tracker.parseRef(row, `${ORIGIN}/platform/billing/docs/-/issues/45`)).toEqual({ number: 45, externalKey: null });
    expect(tracker.parseRef(row, 'platform/other#45')).toBeNull();
    expect(tracker.parseRef(row, 'https://gitlab.com/platform/billing/docs/-/issues/45')).toBeNull();
  });

  it('verifies an Issue Hook by its token, and passes other events through', () => {
    const body = JSON.stringify({
      object_kind: 'issue',
      user: { id: 7 },
      object_attributes: { ...issue('closed'), web_url: undefined, url: issue('closed').web_url, labels: undefined },
      labels: [{ title: 'knowledge' }],
    });
    const hook = { 'x-gitlab-event': 'Issue Hook', 'x-gitlab-token': 's3cret' };
    expect(tracker.verifyWebhook(row, 's3cret', hook, body)).toMatchObject({ actorId: '7', item: { number: 45, state: 'closed', labels: ['knowledge'] } });
    expect(tracker.verifyWebhook(row, 's3cret', { ...hook, 'x-gitlab-token': 'nope' }, body)).toBeNull();
    expect(tracker.verifyWebhook(row, 's3cret', { 'x-gitlab-event': 'Push Hook' }, '{}')).toEqual({ item: null, actorId: null });
  });
});
