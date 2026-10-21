import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connector } from '@prisma/client';
import { workItemStatusFor, workItemStatusMap } from '@knowledge/contracts';

/**
 * Jira as a tracker (#424), against recorded Jira Cloud response shapes. The
 * HTTP layer (`safeFetch`) is replaced by a router over these fixtures, so the
 * whole contract — what is asked for, and how the answer is read — runs in CI
 * without a network. The content pull's move to `/search/jql` is pinned too.
 */

vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
const { safeFetch } = await import('../src/common/safe-fetch.js');
const { JiraTrackerService, adf, adfText } = await import('../src/connectors/adapters/jira-tracker.js');
const { JiraAdapter } = await import('../src/connectors/adapters/jira.adapter.js');
const mockFetch = vi.mocked(safeFetch);

const BASE = 'https://acme.atlassian.net';
const row = {
  id: 'c1',
  kind: 'jira',
  name: 'Jira',
  locale: 'en',
  config: { baseUrl: BASE, projectKey: 'BILL' },
} as unknown as Connector;
const ctx = { config: row.config as Record<string, unknown>, credential: 'me@acme.io:tok', allowPrivate: false, debug: () => undefined, signal: undefined };
const tracker = new JiraTrackerService({ contextFor: async () => ctx } as never);

/** A recorded `GET /rest/api/3/issue/BILL-7` body. */
function issue(status: string, category: 'new' | 'indeterminate' | 'done', updated = '2026-10-21T10:00:00.000+0300') {
  return {
    id: '10042',
    key: 'BILL-7',
    fields: {
      summary: 'Knowledge issue: Billing runbook',
      status: { name: status, statusCategory: { key: category } },
      labels: ['knowledge'],
      reporter: { displayName: 'Dana', accountId: 'acc-1' },
      assignee: null,
      created: '2026-10-21T09:00:00.000+0300',
      updated,
      issuetype: { name: 'Task' },
      description: adf([{ text: 'A reader reported this page as stale.' }, { text: 'knowledge-ref: issue:11111111-1111-4111-8111-111111111111' }]),
    },
  };
}

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let routes: Array<[RegExp, (call: Call) => unknown]>;

beforeEach(() => {
  calls = [];
  routes = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) return new Response('{"errorMessages":["Issue does not exist"]}', { status: 404 });
    const out = route[1](call);
    return new Response(out === undefined ? null : JSON.stringify(out), { status: out === undefined ? 204 : 200 });
  });
});

describe('JiraTrackerService', () => {
  it('reads an issue: site id as number, key as citation, category as state, footer from ADF', async () => {
    routes.push([/GET .*\/rest\/api\/3\/issue\/BILL-7\?fields=/, () => issue('In Progress', 'indeterminate')]);
    const got = await tracker.getIssue(row, { number: 0, externalKey: 'BILL-7' });
    expect(got).toMatchObject({
      number: 10042,
      externalKey: 'BILL-7',
      state: 'open',
      externalStatus: 'In Progress',
      url: `${BASE}/browse/BILL-7`,
      externalUpdatedAt: '2026-10-21T07:00:00.000Z',
    });
    expect(got!.body).toContain('knowledge-ref: issue:11111111-1111-4111-8111-111111111111');
    expect(workItemStatusFor(got!, workItemStatusMap('jira'))).toBe('in_progress');
  });

  it('answers null for a ticket that is gone', async () => {
    expect(await tracker.getIssue(row, { number: 0, externalKey: 'BILL-404' })).toBeNull();
  });

  it('creates in the route project with an ADF body, the label and the issue type', async () => {
    routes.push([/POST .*\/rest\/api\/3\/issue$/, () => ({ id: '10042', key: 'BILL-7' })]);
    routes.push([/GET .*\/rest\/api\/3\/issue\/BILL-7\?/, () => issue('To Do', 'new')]);
    const created = await tracker.createIssue(row, {
      title: 'Knowledge issue: Billing runbook',
      lines: [{ text: 'Stale.' }, { link: 'https://kb/documents/d1', text: 'Open in the knowledge base' }],
      labels: ['knowledge'],
      externalProject: 'OPS',
      issueType: 'Bug',
    });
    expect(created.externalKey).toBe('BILL-7');
    const post = calls.find((c) => c.method === 'POST')!.body as { fields: Record<string, any> };
    expect(post.fields.project).toEqual({ key: 'OPS' });
    expect(post.fields.issuetype).toEqual({ name: 'Bug' });
    expect(post.fields.labels).toEqual(['knowledge']);
    expect(post.fields.description.content[1].content[0].marks[0]).toEqual({ type: 'link', attrs: { href: 'https://kb/documents/d1' } });
  });

  it('falls back to the connector project, and refuses with none', async () => {
    routes.push([/POST .*\/rest\/api\/3\/issue$/, () => ({ id: '10042', key: 'BILL-7' })]);
    routes.push([/GET .*\/rest\/api\/3\/issue\/BILL-7\?/, () => issue('To Do', 'new')]);
    await tracker.createIssue(row, { title: 't', lines: [], labels: [] });
    expect((calls[0].body as any).fields.project).toEqual({ key: 'BILL' });
    const bare = { ...row, config: { baseUrl: BASE } } as unknown as Connector;
    const none = new JiraTrackerService({ contextFor: async () => ({ ...ctx, config: bare.config }) } as never);
    await expect(none.createIssue(bare, { title: 't', lines: [], labels: [] })).rejects.toThrow();
  });

  it('transitions through the workflow transition whose target matches, case-insensitively', async () => {
    let status = issue('In Progress', 'indeterminate');
    routes.push([/GET .*\/transitions$/, () => ({ transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }, { id: '31', name: 'Finish', to: { name: 'Done' } }] })]);
    routes.push([/POST .*\/transitions$/, () => { status = issue('Done', 'done', '2026-10-21T12:00:00.000+0000'); return undefined; }]);
    routes.push([/GET .*\/rest\/api\/3\/issue\/BILL-7\?/, () => status]);
    const moved = await tracker.transition(row, { number: 10042, externalKey: 'BILL-7' }, 'done');
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ transition: { id: '31' } });
    expect(moved).toMatchObject({ state: 'closed', externalStatus: 'Done' });
  });

  it("refuses a status the workflow cannot reach from here, and skips one it is already in", async () => {
    routes.push([/GET .*\/transitions$/, () => ({ transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }] })]);
    routes.push([/GET .*\/rest\/api\/3\/issue\/BILL-7\?/, () => issue('In Progress', 'indeterminate')]);
    await expect(tracker.transition(row, { number: 10042, externalKey: 'BILL-7' }, "Won't Do")).rejects.toThrow();
    const same = await tracker.transition(row, { number: 10042, externalKey: 'BILL-7' }, 'in progress');
    expect(same?.externalStatus).toBe('In Progress');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('polls the label plus the watched keys, oldest change first, a day early for JQL time zones', async () => {
    routes.push([/GET .*\/rest\/api\/3\/search\/jql\?/, () => ({ issues: [issue('Done', 'done', '2026-10-21T12:00:00.000+0000')], isLast: true })]);
    const { items, cursor } = await tracker.listIssues(row, '2026-10-21T10:00:00.000Z', [
      { number: 10042, externalKey: 'BILL-7' },
      { number: 1, externalKey: 'not a key) OR 1=1 (' },
    ]);
    const jql = new URL(calls[0].url).searchParams.get('jql');
    expect(jql).toBe('(labels = "knowledge" OR key in (BILL-7)) AND updated >= "2026/10/20 10:00" ORDER BY updated ASC');
    expect(items).toHaveLength(1);
    expect(cursor).toBe('2026-10-21T12:00:00.000Z');
  });

  it('reads a ref as a key or a browse URL on its own site', () => {
    expect(tracker.parseRef(row, 'bill-7')).toEqual({ number: 0, externalKey: 'BILL-7' });
    expect(tracker.parseRef(row, `${BASE}/browse/BILL-7`)).toEqual({ number: 0, externalKey: 'BILL-7' });
    expect(tracker.parseRef(row, 'https://evil.atlassian.net/browse/BILL-7')).toBeNull();
    expect(tracker.parseRef(row, '#45')).toBeNull();
  });

  it('verifies a signed webhook and names the actor by accountId', () => {
    const body = JSON.stringify({ webhookEvent: 'jira:issue_updated', user: { accountId: 'acc-2' }, issue: issue('Done', 'done') });
    const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    const ok = tracker.verifyWebhook(row, 's3cret', { 'x-hub-signature': sig }, body);
    expect(ok).toMatchObject({ actorId: 'acc-2', item: { externalKey: 'BILL-7', state: 'closed' } });
    expect(tracker.verifyWebhook(row, 'wrong', { 'x-hub-signature': sig }, body)).toBeNull();
  });

  it('round-trips ADF to text', () => {
    expect(adfText(adf([{ text: 'one' }, { link: 'https://x', text: 'two' }]))).toBe('one\ntwo');
    expect(adfText(null)).toBeNull();
  });
});

describe('JiraAdapter content pull', () => {
  it('pages /search/jql by token, not the deprecated offset /search', async () => {
    routes.push([/search\/jql\?.*nextPageToken=t2/, () => ({ issues: [{ key: 'ENG-2', fields: { summary: 'Two' } }], isLast: true })]);
    routes.push([/search\/jql\?/, () => ({ issues: [{ key: 'ENG-1', fields: { summary: 'One' } }], nextPageToken: 't2', isLast: false })]);
    const refs = [];
    for await (const ref of new JiraAdapter().list({ ...ctx, config: { baseUrl: BASE, jql: 'project = ENG' } } as never)) refs.push(ref.externalId);
    expect(refs).toEqual(['ENG-1', 'ENG-2']);
    expect(calls.every((c) => c.url.includes('/rest/api/3/search/jql'))).toBe(true);
  });
});
