import { describe, expect, it } from 'vitest';

/**
 * The GitHub access card's comparison (docs/features/36).
 *
 * The card is only worth reading if it tells the two fixes apart — *pending*
 * (the installation's owner accepts on GitHub) and *missing* (the App
 * registration has to ask first) — and only flags gaps in features the
 * connector actually uses. Those are the cases here.
 */
const { activePurposes, asLevel, eventRows, permissionRows } = await import(
  '../src/connectors/github/github-access.js'
);

const codebase = activePurposes({ kind: 'codebase', direction: 'pull', driftCheck: 'off' });
const withDrift = activePurposes({ kind: 'codebase', direction: 'pull', driftCheck: 'report' });

const row = (rows: Array<{ name: string }>, name: string) => rows.find((r) => r.name === name) as any;

describe('activePurposes', () => {
  it('uses sync and work items always, push only for a pushing markdown-git, drift only when on', () => {
    expect([...codebase].sort()).toEqual(['sync', 'work-items']);
    expect(activePurposes({ kind: 'markdown-git', direction: 'both', driftCheck: 'off' }).has('push')).toBe(true);
    expect(activePurposes({ kind: 'markdown-git', direction: 'pull', driftCheck: 'off' }).has('push')).toBe(false);
    expect(withDrift.has('drift-check')).toBe(true);
  });

  it('adds the repo wiki only for a codebase connector regenerating on push (docs/features/46)', () => {
    expect(activePurposes({ kind: 'codebase', direction: 'pull', driftCheck: 'off', wikiOnPush: true }).has('wiki')).toBe(true);
    expect(activePurposes({ kind: 'codebase', direction: 'pull', driftCheck: 'off', wikiOnPush: false }).has('wiki')).toBe(false);
    expect(activePurposes({ kind: 'markdown-git', direction: 'pull', driftCheck: 'off', wikiOnPush: true }).has('wiki')).toBe(false);
  });

  it('marks the push event as needed by the wiki, and contents:read with it', () => {
    const active = activePurposes({ kind: 'codebase', direction: 'pull', driftCheck: 'off', wikiOnPush: true });
    const push = row(eventRows([], [], active), 'push');
    expect(push).toMatchObject({ status: 'missing', active: true });
    expect(push.purposes).toContain('wiki');
    expect(row(permissionRows({ contents: 'read' }, {}, active), 'contents').purposes).toContain('wiki');
  });

  it('marks pull requests and the release event as needed by release notes', () => {
    const active = activePurposes({ kind: 'codebase', direction: 'pull', driftCheck: 'off', changelog: true });
    expect(active.has('changelog')).toBe(true);
    expect(row(eventRows([], [], active), 'release')).toMatchObject({ status: 'missing', active: true });
    expect(row(permissionRows({ pull_requests: 'read' }, {}, active), 'pull_requests')).toMatchObject({ status: 'granted', needed: 'read' });
  });
});

describe('permissionRows', () => {
  it('tells granted, pending and missing apart', () => {
    const rows = permissionRows(
      { metadata: 'read', contents: 'read', issues: 'read' },
      { metadata: 'read', contents: 'read', issues: 'write', pull_requests: 'read' },
      withDrift,
    );
    expect(row(rows, 'contents').status).toBe('granted');
    expect(row(rows, 'issues')).toMatchObject({ status: 'pending', granted: 'read', requested: 'write', needed: 'write' });
    // The App asks for read, the drift check needs write: the registration must change.
    expect(row(rows, 'pull_requests')).toMatchObject({ status: 'missing', active: true, needed: 'write' });
  });

  it('asks only for what active purposes need, and does not flag an unused gap', () => {
    const rows = permissionRows({ contents: 'read' }, { contents: 'read' }, codebase);
    // contents:write is for push, which a pull-only codebase does not do.
    expect(row(rows, 'contents')).toMatchObject({ status: 'granted', needed: 'read' });
    // No drift check: pull_requests is listed, still missing, but not active.
    expect(row(rows, 'pull_requests')).toMatchObject({ status: 'missing', active: false });
    // Boards are decoration and never active.
    expect(row(rows, 'organization_projects').active).toBe(false);
  });

  it('treats a stronger grant as enough, and lists grants nothing here uses as extra', () => {
    const rows = permissionRows({ issues: 'admin', checks: 'write' }, { issues: 'admin', checks: 'write' }, codebase);
    expect(row(rows, 'issues').status).toBe('granted');
    expect(row(rows, 'checks')).toMatchObject({ status: 'extra', needed: null, purposes: [] });
  });

  it('sorts active problems first', () => {
    const rows = permissionRows({ metadata: 'read' }, { metadata: 'read', issues: 'write' }, codebase);
    expect(rows[0]).toMatchObject({ active: true });
    expect(['missing', 'pending']).toContain(rows[0].status);
    expect(rows.findIndex((r) => r.name === 'metadata')).toBeGreaterThan(rows.findIndex((r) => r.name === 'issues'));
  });

  it('reads anything that is not a level as absent', () => {
    expect(asLevel('write')).toBe('write');
    expect(asLevel('WRITE')).toBeNull();
    expect(asLevel(undefined)).toBeNull();
  });
});

describe('eventRows', () => {
  it('marks a subscribed event granted, a requested one pending, and an unrequested one missing', () => {
    const rows = eventRows(['issues', 'push'], ['issues', 'push', 'pull_request'], withDrift);
    expect(row(rows, 'issues').status).toBe('granted');
    expect(row(rows, 'pull_request')).toMatchObject({ status: 'pending', active: true });
    expect(row(rows, 'issue_comment')).toMatchObject({ status: 'missing', active: true });
    expect(row(rows, 'release').active).toBe(false);
  });

  it('keeps events nothing here uses as extra', () => {
    expect(row(eventRows(['star'], ['star'], codebase), 'star').status).toBe('extra');
  });
});
