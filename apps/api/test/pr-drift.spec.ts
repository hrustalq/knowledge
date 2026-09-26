import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AgentRunPullRequest } from '@knowledge/contracts';

/**
 * The drift check's deterministic half (docs/features/35).
 *
 * Three things here decide what a pull request costs and who sees what, and
 * none of them is visible from a green run:
 *
 * 1. **Which deliveries start a check.** A title edit, a draft, a fork or a
 *    closed pull request must not — each is a model run nobody asked for, and a
 *    fork is a stranger spending the connector owner's budget.
 * 2. **Which pages a change is tied to.** The deepest module owns a file, a
 *    change to the repository's shape reaches the hub, and a markdown page the
 *    change itself edits is never judged against it.
 * 3. **What a judgement must carry to count** — and what a comment on
 *    somebody's pull request may contain.
 */
const {
  isPullRequestEvent,
  readGithubPullRequest,
  readGitlabMergeRequest,
  readPullRequestDelivery,
  verifyRepoDelivery,
} = await import('../src/connectors/drift/pull-request-delivery.js');
const { diffExcerpt, linkedCandidates, mentionedFiles, readDriftVerdict, scopeFiles, subdirOf } = await import(
  '../src/agents/drift.js'
);
const { driftCommentMarker, renderDriftComment } = await import('../src/connectors/drift/drift-report.js');
const { driftCheckMode } = await import('@knowledge/contracts');

const githubPayload = (overrides: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
  action: 'opened',
  ...overrides,
  pull_request: {
    number: 42,
    title: 'Rename retry option',
    html_url: 'https://github.com/acme/app/pull/42',
    state: 'open',
    draft: false,
    user: { login: 'dana' },
    head: { sha: 'abc1234def', ref: 'feat/retry', repo: { id: 7 } },
    base: { ref: 'main', repo: { id: 7 } },
    ...pr,
  },
});

const gitlabPayload = (attrs: Record<string, unknown> = {}) => ({
  object_kind: 'merge_request',
  user: { username: 'red' },
  object_attributes: {
    iid: 9,
    title: 'Change the default timeout',
    url: 'https://gitlab.com/acme/app/-/merge_requests/9',
    state: 'opened',
    action: 'open',
    source_branch: 'timeout',
    target_branch: 'main',
    source_project_id: 3,
    target_project_id: 3,
    last_commit: { id: 'ffee001122' },
    ...attrs,
  },
});

const pr: AgentRunPullRequest = {
  number: 42,
  title: 'Rename retry option',
  url: 'https://github.com/acme/app/pull/42',
  headSha: 'abc1234def',
  headRef: 'feat/retry',
  baseRef: 'main',
  author: 'dana',
};

describe('which GitHub deliveries start a check', () => {
  it('reads an opened pull request into the run input', () => {
    expect(readGithubPullRequest('pull_request', githubPayload())?.pullRequest).toEqual(pr);
  });

  it('checks on open, reopen, a push to the branch and a draft becoming ready', () => {
    for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
      expect(readGithubPullRequest('pull_request', githubPayload({ action }))).not.toBeNull();
    }
  });

  it('ignores actions that say nothing about the code', () => {
    for (const action of ['edited', 'labeled', 'assigned', 'closed', 'review_requested']) {
      expect(readGithubPullRequest('pull_request', githubPayload({ action }))).toBeNull();
    }
  });

  it('ignores drafts, closed pull requests and other events', () => {
    expect(readGithubPullRequest('pull_request', githubPayload({}, { draft: true }))).toBeNull();
    expect(readGithubPullRequest('pull_request', githubPayload({}, { state: 'closed' }))).toBeNull();
    expect(readGithubPullRequest('push', githubPayload())).toBeNull();
  });

  it('refuses a fork, and a fork that has since been deleted', () => {
    expect(readGithubPullRequest('pull_request', githubPayload({}, { head: { sha: 'x', repo: { id: 8 } } }))).toBeNull();
    expect(readGithubPullRequest('pull_request', githubPayload({}, { head: { sha: 'x', repo: null } }))).toBeNull();
  });
});

describe('which GitLab deliveries start a check', () => {
  it('reads an opened merge request by its iid', () => {
    const read = readGitlabMergeRequest(gitlabPayload());
    expect(read?.pullRequest).toMatchObject({ number: 9, headSha: 'ffee001122', headRef: 'timeout', author: 'red' });
  });

  it('checks an update only when it carries new commits', () => {
    expect(readGitlabMergeRequest(gitlabPayload({ action: 'update', oldrev: 'aaa' }))).not.toBeNull();
    expect(readGitlabMergeRequest(gitlabPayload({ action: 'update' }))).toBeNull();
  });

  it('ignores drafts, merges, closes and forks', () => {
    expect(readGitlabMergeRequest(gitlabPayload({ draft: true }))).toBeNull();
    expect(readGitlabMergeRequest(gitlabPayload({ action: 'merge', state: 'merged' }))).toBeNull();
    expect(readGitlabMergeRequest(gitlabPayload({ action: 'close', state: 'closed' }))).toBeNull();
    expect(readGitlabMergeRequest(gitlabPayload({ source_project_id: 4 }))).toBeNull();
  });

  it('routes by header: a GitHub event name means GitHub, its absence means GitLab', () => {
    expect(readPullRequestDelivery({ 'x-github-event': 'pull_request' }, githubPayload())?.pullRequest.number).toBe(42);
    expect(readPullRequestDelivery({ 'x-gitlab-event': 'Merge Request Hook' }, gitlabPayload())?.pullRequest.number).toBe(9);
    expect(isPullRequestEvent({ 'x-github-event': 'push' }, { commits: [] })).toBe(false);
    expect(isPullRequestEvent({}, gitlabPayload())).toBe(true);
  });
});

describe('verifyRepoDelivery', () => {
  const body = JSON.stringify(gitlabPayload());

  it('accepts GitLab only with the exact token', () => {
    expect(verifyRepoDelivery({ 'x-gitlab-token': 's3cret' }, body, 's3cret')).toBe(true);
    expect(verifyRepoDelivery({ 'x-gitlab-token': 's3cre' }, body, 's3cret')).toBe(false);
    expect(verifyRepoDelivery({ 'x-gitlab-token': '' }, body, 's3cret')).toBe(false);
  });

  it('accepts GitHub only with a signature over the raw body', () => {
    const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(verifyRepoDelivery({ 'x-hub-signature-256': sig }, body, 's3cret')).toBe(true);
    expect(verifyRepoDelivery({ 'x-hub-signature-256': sig }, `${body} `, 's3cret')).toBe(false);
    expect(verifyRepoDelivery({}, body, 's3cret')).toBe(false);
  });
});

describe('driftCheckMode', () => {
  it('reads an absent or unknown value as off, so older connectors do nothing', () => {
    expect(driftCheckMode({})).toBe('off');
    expect(driftCheckMode(null)).toBe('off');
    expect(driftCheckMode({ driftCheck: 'loud' })).toBe('off');
    expect(driftCheckMode({ driftCheck: 'propose' })).toBe('propose');
  });
});

const file = (path: string, status: 'added' | 'modified' | 'removed' | 'renamed' = 'modified', previousPath: string | null = null) => ({
  path,
  previousPath,
  status,
  patch: `@@ -1 +1 @@\n-old ${path}\n+new ${path}`,
});

describe('linkedCandidates', () => {
  const links = [
    { externalId: 'overview', documentId: 'hub' },
    { externalId: 'module:', documentId: 'root' },
    { externalId: 'module:apps/api', documentId: 'api' },
    { externalId: 'module:apps/api/billing', documentId: 'billing' },
  ];

  it('ties a changed file to the deepest module that contains it, never a shallower one too', () => {
    const { ties } = linkedCandidates('codebase', links, [file('apps/api/billing/invoice.ts')]);
    expect([...ties.keys()]).toEqual(['billing']);
    expect(ties.get('billing')?.files).toEqual(['apps/api/billing/invoice.ts']);
  });

  it('falls back to the root module for a file no deeper module owns', () => {
    const { ties } = linkedCandidates('codebase', links, [file('scripts/deploy.sh')]);
    expect([...ties.keys()]).toEqual(['root']);
  });

  it('does not let a module claim a sibling that merely shares its prefix', () => {
    const { ties } = linkedCandidates('codebase', links, [file('apps/api-gateway/main.ts')]);
    expect([...ties.keys()]).toEqual(['root']);
  });

  it('reaches the hub when the repository changes shape', () => {
    expect(linkedCandidates('codebase', links, [file('apps/api/package.json')]).ties.has('hub')).toBe(true);
    expect(linkedCandidates('codebase', links, [file('apps/api/new.ts', 'added')]).ties.has('hub')).toBe(true);
    expect(linkedCandidates('codebase', links, [file('apps/api/old.ts', 'removed')]).ties.has('hub')).toBe(true);
    expect(linkedCandidates('codebase', links, [file('apps/api/x.ts')]).ties.has('hub')).toBe(false);
  });

  it('treats a markdown page the change edits as documenting itself, never as a candidate', () => {
    const md = [{ externalId: 'docs/retry.md', documentId: 'retry' }];
    const { ties, inChange } = linkedCandidates('markdown-git', md, [file('docs/retry.md'), file('src/retry.ts')]);
    expect(ties.size).toBe(0);
    expect([...inChange]).toEqual(['retry']);
  });

  it('recognises a moved markdown page by its old path', () => {
    const md = [{ externalId: 'docs/old.md', documentId: 'moved' }];
    expect(linkedCandidates('markdown-git', md, [file('docs/new.md', 'renamed', 'docs/old.md')]).inChange.has('moved')).toBe(true);
  });
});

describe('scope and mentions', () => {
  it('keeps only the part of the change under the connector subdir, including a move into it', () => {
    const files = [file('src/a.ts'), file('docs/b.md'), file('src/c.ts', 'renamed', 'lib/c.ts')];
    expect(scopeFiles(files, 'src').map((f) => f.path)).toEqual(['src/a.ts', 'src/c.ts']);
    expect(scopeFiles(files, '')).toHaveLength(3);
    expect(subdirOf({ subdir: '/src/' })).toBe('src');
    expect(subdirOf(null)).toBe('');
  });

  it('finds a page that names a changed file by path, by old path, or by a specific filename', () => {
    const files = [file('src/pricing/discounts.ts'), file('src/util/index.ts'), file('src/new.ts', 'renamed', 'src/legacy-retry.ts')];
    expect(mentionedFiles('See src/pricing/discounts.ts for the rules.', files)).toEqual(['src/pricing/discounts.ts']);
    expect(mentionedFiles('The Discounts module applies…', files)).toEqual(['src/pricing/discounts.ts']);
    expect(mentionedFiles('Retries live in legacy-retry.', files)).toEqual(['src/new.ts']);
    // `index` is a generic name: a page saying "index" is not about that file.
    expect(mentionedFiles('The search index is rebuilt nightly.', files)).toEqual([]);
  });
});

describe('diffExcerpt', () => {
  it('cuts at a file boundary and says how much it left out', () => {
    const files = [file('a.ts'), file('b.ts'), file('c.ts')];
    const one = diffExcerpt(files, 60);
    expect(one).toContain('--- a.ts [modified]');
    expect(one).not.toContain('--- b.ts');
    expect(one).toContain('[2 more changed file(s) not shown]');
  });

  it('still lists a file whose patch the host withheld', () => {
    expect(diffExcerpt([{ ...file('logo.png'), patch: null }], 1_000)).toContain('no diff available');
  });
});

describe('readDriftVerdict', () => {
  const page = { id: 'doc-1', title: 'Retry policy', markdown: '# Retry policy\n\nSet `retries` to…' };
  const draft = `# Retry policy\n\n${'Set `maxAttempts` (formerly `retries`) to the number of attempts. '.repeat(5)}`;

  it('turns a drifted verdict into a stale finding that cites the page and the pull request', () => {
    const f = readDriftVerdict(
      { drifted: true, severity: 'error', title: 'option renamed', detail: 'The page says `retries`.', markdown: draft },
      page,
      pr,
    );
    expect(f).toMatchObject({
      kind: 'stale',
      severity: 'error',
      title: 'Retry policy — option renamed',
      documentIds: ['doc-1'],
      draft: { title: 'Retry policy', markdown: draft.trim() },
    });
    expect(f?.sources?.[0]).toMatchObject({ url: pr.url, site: 'github.com' });
  });

  it('returns nothing for a page that did not drift, or a verdict missing its reasons', () => {
    expect(readDriftVerdict({ drifted: false, title: '', detail: '', markdown: null }, page, pr)).toBeNull();
    expect(readDriftVerdict({ drifted: true, title: 'x', detail: '' }, page, pr)).toBeNull();
    expect(readDriftVerdict(null, page, pr)).toBeNull();
  });

  it('keeps the finding but drops a draft that is a sentence, or the page unchanged', () => {
    const short = readDriftVerdict({ drifted: true, title: 'x', detail: 'y', markdown: 'Fixed.' }, page, pr);
    expect(short?.draft).toBeUndefined();
    const same = readDriftVerdict({ drifted: true, title: 'x', detail: 'y', markdown: page.markdown }, page, pr);
    expect(same?.draft).toBeUndefined();
  });

  it('defaults an unknown severity to a warning', () => {
    expect(readDriftVerdict({ drifted: true, severity: 'fatal', title: 'x', detail: 'y' }, page, pr)?.severity).toBe('warning');
  });
});

describe('renderDriftComment', () => {
  const finding = {
    kind: 'stale' as const,
    severity: 'warning' as const,
    title: 'Retry policy — option renamed',
    detail: 'The page says @dana owns `retries`.\n\n<script>alert(1)</script>',
    documentIds: ['doc-1'],
    documentTitles: ['Retry [policy]'],
  };

  it('links each page and its proposal, on one line, without mentions or raw HTML', () => {
    const body = renderDriftComment({
      webBaseUrl: 'https://kb.example.com/',
      connectorName: 'app',
      pullRequest: pr,
      entries: [{ finding, mergeRequestId: 'mr-1' }],
    });
    expect(body).toContain('[Retry \\[policy\\]](https://kb.example.com/documents/doc-1)');
    expect(body).toContain('(https://kb.example.com/merge-requests/mr-1)');
    expect(body).not.toContain('@dana');
    expect(body).not.toContain('<script>');
    expect(body.split('\n').filter((l) => l.includes('owns'))).toHaveLength(1);
  });

  it('says the pull request is clean when nothing drifted', () => {
    const body = renderDriftComment({ webBaseUrl: 'https://kb', connectorName: 'app', pullRequest: pr, entries: [] });
    expect(body).toContain('agent.drift.comment.clean');
    expect(body).not.toContain('documents/');
  });

  it('keys the marker by connector, so two connectors on one repository keep a comment each', () => {
    expect(driftCommentMarker('a')).not.toBe(driftCommentMarker('b'));
    expect(driftCommentMarker('a')).toMatch(/^<!--.*-->$/);
  });
});
