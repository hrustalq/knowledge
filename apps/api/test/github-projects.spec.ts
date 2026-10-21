import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connector } from '@prisma/client';

/**
 * GitHub org Projects v2 as a handoff's board (#424), through a mocked
 * `safeFetch` (CI, no network): what the board URL resolves to, which option a
 * status picks, and the add-then-set sequence — all best effort around an
 * issue whose own state is the status.
 */

vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
const { safeFetch } = await import('../src/common/safe-fetch.js');
const { GithubIssuesService, boardOptionFor } = await import('../src/connectors/github/github-issues.service.js');
const { GITHUB_EVENT_REQUIREMENTS, GITHUB_PERMISSION_REQUIREMENTS } = await import('../src/connectors/github/github-access.js');
const mockFetch = vi.mocked(safeFetch);

const row = { id: 'c1', kind: 'markdown-git', locale: 'en', config: { repoUrl: 'https://github.com/acme/app' } } as unknown as Connector;
const service = new GithubIssuesService(
  { contextFor: async () => ({ config: row.config, credential: 'ghs_x', locale: 'en' }) } as never,
  { apiUrl: 'https://api.github.com' } as never,
);

let queries: Array<{ query: string; variables: Record<string, unknown> }>;
let answer: (query: string) => unknown;

beforeEach(() => {
  queries = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    queries.push(body);
    return new Response(JSON.stringify({ data: answer(body.query) }), { status: 200 });
  });
});

const OPTIONS = [
  { id: 'o-todo', name: 'Todo' },
  { id: 'o-prog', name: 'In Progress' },
  { id: 'o-done', name: 'Done' },
];

describe('boardOptionFor', () => {
  it("picks the template's column for each status, and Done for won't-do when there is no such column", () => {
    expect(boardOptionFor(OPTIONS, 'open')).toBe('o-todo');
    expect(boardOptionFor(OPTIONS, 'in_progress')).toBe('o-prog');
    expect(boardOptionFor(OPTIONS, 'wont_do')).toBe('o-done');
    expect(boardOptionFor([...OPTIONS, { id: 'o-wont', name: "Won't do" }], 'wont_do')).toBe('o-wont');
    expect(boardOptionFor([{ id: 'x', name: 'Icebox' }], 'open')).toBeNull();
  });
});

describe('resolveBoard', () => {
  it('reads an org board URL into the board and its Status field', async () => {
    answer = () => ({ organization: { projectV2: { id: 'PVT_1', field: { id: 'PVTSSF_1' } } } });
    await expect(service.resolveBoard(row, 'https://github.com/orgs/acme/projects/5/views/1')).resolves.toEqual({ nodeId: 'PVT_1', fieldId: 'PVTSSF_1' });
    expect(queries[0].variables).toEqual({ org: 'acme', n: 5 });
  });

  it('refuses a user-owned board, a non-board URL and a board with no Status field', async () => {
    await expect(service.resolveBoard(row, 'https://github.com/users/dana/projects/2')).rejects.toThrow();
    await expect(service.resolveBoard(row, 'https://github.com/acme/app/issues/1')).rejects.toThrow();
    answer = () => ({ organization: { projectV2: { id: 'PVT_1', field: null } } });
    await expect(service.resolveBoard(row, 'https://github.com/orgs/acme/projects/5')).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('setBoardStatus', () => {
  const board = { nodeId: 'PVT_1', fieldId: 'PVTSSF_1' };

  it('adds the card when it is not on the board, then sets the column', async () => {
    answer = (q) =>
      q.includes('addProjectV2ItemById')
        ? { addProjectV2ItemById: { item: { id: 'PVTI_new' } } }
        : q.includes('updateProjectV2ItemFieldValue')
          ? { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_new' } } }
          : { repository: { issue: { id: 'I_7', projectItems: { nodes: [] } } }, node: { options: OPTIONS } };
    expect(await service.setBoardStatus(row, { number: 7, externalKey: null }, board, 'done')).toBe(true);
    expect(queries.map((q) => (q.query.includes('add') ? 'add' : q.query.includes('update') ? 'set' : 'read'))).toEqual(['read', 'add', 'set']);
    expect(queries[2].variables).toEqual({ p: 'PVT_1', i: 'PVTI_new', f: 'PVTSSF_1', o: 'o-done' });
  });

  it('moves a card already on the board without adding it again', async () => {
    answer = (q) =>
      q.includes('update') ? {} : { repository: { issue: { id: 'I_7', projectItems: { nodes: [{ id: 'PVTI_1', project: { id: 'PVT_1' } }] } } }, node: { options: OPTIONS } };
    expect(await service.setBoardStatus(row, { number: 7, externalKey: null }, board, 'open')).toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries[1].variables.i).toBe('PVTI_1');
  });

  it('never throws: a GraphQL error is a false', async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ errors: [{ message: 'Resource not accessible by integration' }] }), { status: 200 }));
    expect(await service.setBoardStatus(row, { number: 7, externalKey: null }, board, 'done')).toBe(false);
  });
});

describe('GitHub App catalogue', () => {
  it('asks for write on org projects and the card event', () => {
    expect(GITHUB_PERMISSION_REQUIREMENTS.find((p) => p.name === 'organization_projects')?.level).toBe('write');
    expect(GITHUB_EVENT_REQUIREMENTS.some((e) => e.name === 'projects_v2_item')).toBe(true);
  });
});
