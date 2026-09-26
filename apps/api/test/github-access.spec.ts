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
