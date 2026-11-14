import { describe, expect, it } from 'vitest';
import { mayReadRun, privateRunWhere } from '../src/ai/run-privacy.js';
import type { Principal } from '../src/auth/principal.js';

/** #1089: a memo's analysis is its uploader's. The filter and the row check say the same thing. */
const person = (userId: string, over: Partial<Principal> = {}): Principal =>
  ({ userId, email: null, displayName: userId, avatarUrl: null, mode: 'session', isAdmin: false, locale: 'en', ...over }) as Principal;

/** `privateRunWhere` evaluated over one row, for the shapes it can produce. */
function matches(where: ReturnType<typeof privateRunWhere>, row: { subjectKey: string | null; createdBy: string }): boolean {
  if (!where.OR) return true;
  return where.OR.some((clause) => {
    if ('subjectKey' in clause && clause.subjectKey === null) return row.subjectKey === null;
    if ('createdBy' in clause) return row.createdBy === clause.createdBy;
    const prefix = (clause.NOT as { subjectKey: { startsWith: string } }).subjectKey.startsWith;
    return row.subjectKey !== null && !row.subjectKey.startsWith(prefix);
  });
}

const ROWS = [
  { subjectKey: 'memo:m1', createdBy: 'alice' },
  { subjectKey: 'path:docs/a.md', createdBy: 'alice' },
  { subjectKey: null, createdBy: 'alice' },
];

describe('run privacy (#1089)', () => {
  it.each([
    ['the uploader', person('alice'), [true, true, true]],
    ['another member', person('bob'), [false, true, true]],
    ['a platform admin', person('root', { isAdmin: true }), [true, true, true]],
    ['the dev principal', person('dev', { mode: 'dev' }), [true, true, true]],
  ])('%s', (_who, principal, expected) => {
    expect(ROWS.map((row) => mayReadRun(row, principal))).toEqual(expected);
    expect(ROWS.map((row) => matches(privateRunWhere(principal), row))).toEqual(expected);
  });
});
