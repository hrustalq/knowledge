import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { toWorkItem } from '../src/connectors/github/github-issues.service.js';
import { safeJson, verifyHubSignature } from '../src/connectors/webhook-payload.js';

/**
 * Work items (docs/features/32).
 *
 * Two things here are load-bearing and neither is obvious from reading the
 * code, which is why they are the whole file:
 *
 * 1. **The state mapping.** GitHub reports a merged pull request as `closed`,
 *    exactly like an abandoned one, and the two say opposite things about
 *    whether the work happened. Every flow that fires on "done" reads our
 *    `merged`, so collapsing the two would make those flows fire on abandoned
 *    work — silently, and only in production.
 * 2. **The signature check.** It is the only thing standing between a
 *    `@Public()` endpoint and anyone who can reach the URL, so the rejection
 *    cases are the point rather than decoration around the happy path.
 */

const issue = {
  number: 412,
  title: 'Search drops Cyrillic titles',
  state: 'open',
  html_url: 'https://github.com/acme/app/issues/412',
  user: { login: 'dana' },
  assignees: [{ login: 'red' }, { login: 'blue' }],
  labels: [{ name: 'bug' }, 'regression'],
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-02T11:00:00Z',
};

describe('toWorkItem', () => {
  it('reads a plain issue', () => {
    const item = toWorkItem(issue);
    expect(item.kind).toBe('issue');
    expect(item.state).toBe('open');
    expect(item.number).toBe(412);
    expect(item.authorLogin).toBe('dana');
    expect(item.assigneeLogins).toEqual(['red', 'blue']);
    // Labels arrive as objects from the REST list and as bare strings from some
    // webhook payloads; both shapes have to survive.
    expect(item.labels).toEqual(['bug', 'regression']);
  });

  it('separates a merged pull request from an abandoned one', () => {
    const merged = toWorkItem({
      ...issue,
      state: 'closed',
      pull_request: { merged_at: '2026-09-03T09:00:00Z' },
    });
    const abandoned = toWorkItem({ ...issue, state: 'closed', pull_request: { merged_at: null } });

    expect(merged.kind).toBe('pull-request');
    expect(merged.state).toBe('merged');
    expect(abandoned.kind).toBe('pull-request');
    expect(abandoned.state).toBe('closed');
    // The distinction the whole vocabulary exists for.
    expect(merged.state).not.toBe(abandoned.state);
  });

  it('calls an open draft pull request a draft, not open', () => {
    const draft = toWorkItem({ ...issue, pull_request: { merged_at: null }, draft: true });
    expect(draft.state).toBe('draft');
  });

  it('does not call a closed issue merged just because it is closed', () => {
    expect(toWorkItem({ ...issue, state: 'closed' }).state).toBe('closed');
  });

  it('survives a payload missing every optional field', () => {
    const bare = toWorkItem({ number: 1, title: 'x', state: 'open', html_url: 'https://example.com/1' });
    expect(bare.authorLogin).toBeNull();
    expect(bare.assigneeLogins).toEqual([]);
    expect(bare.labels).toEqual([]);
    expect(bare.externalCreatedAt).toBeNull();
  });
});

describe('verifyHubSignature', () => {
  const secret = 'a-shared-secret';
  const body = JSON.stringify({ action: 'opened', issue: { number: 1 } });
  const good = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  it('accepts a correct signature', () => {
    expect(verifyHubSignature({ 'x-hub-signature-256': good }, body, secret)).toBe(true);
  });

  it('accepts it without the sha256= prefix', () => {
    expect(verifyHubSignature({ 'x-hub-signature-256': good.slice(7) }, body, secret)).toBe(true);
  });

  it('refuses a body that changed by one byte', () => {
    expect(verifyHubSignature({ 'x-hub-signature-256': good }, body + ' ', secret)).toBe(false);
  });

  it('refuses the wrong secret', () => {
    expect(verifyHubSignature({ 'x-hub-signature-256': good }, body, 'not-the-secret')).toBe(false);
  });

  it('refuses a missing header rather than treating absence as valid', () => {
    expect(verifyHubSignature({}, body, secret)).toBe(false);
  });

  it('refuses a malformed header without throwing', () => {
    // Non-hex would make Buffer.from produce a short buffer; timingSafeEqual
    // throws on a length mismatch, so the length guard has to come first.
    expect(verifyHubSignature({ 'x-hub-signature-256': 'sha256=zzzz' }, body, secret)).toBe(false);
  });
});

describe('safeJson', () => {
  it('parses an object', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads anything that is not an object as absent', () => {
    expect(safeJson('nonsense')).toBeNull();
    expect(safeJson('"a string"')).toBeNull();
    expect(safeJson('null')).toBeNull();
  });
});
