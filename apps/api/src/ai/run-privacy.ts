import type { Prisma } from '@prisma/client';
import type { Principal } from '../auth/principal.js';

/**
 * The `subject_key` prefix of a memo's analysis: `MemosProcessor.analyse`
 * spells the key from this, and the predicates below read it, so the two
 * cannot drift.
 */
export const MEMO_RUN_PREFIX = 'memo:';

/**
 * A memo is its uploader's (doc 68, `MemosService.require`), and so is the
 * `secretary` run that analyses it (#1089): its summary and drafts are the
 * recording in other words. Anyone else reads such a run as missing, whatever
 * their role. A platform admin sees it, as they see the memo; so does the dev
 * principal. Every other run is the workspace's, as before.
 *
 * Two spellings of one rule (a Prisma filter for lists and counts, a check
 * for one row), both reading only `subject_key` and `created_by`.
 */
export function privateRunWhere(principal: Principal): Prisma.AgentRunWhereInput {
  if (seesEveryRun(principal)) return {};
  return {
    OR: [{ subjectKey: null }, { NOT: { subjectKey: { startsWith: MEMO_RUN_PREFIX } } }, { createdBy: principal.userId }],
  };
}

export function mayReadRun(run: { subjectKey: string | null; createdBy: string }, principal: Principal): boolean {
  return seesEveryRun(principal) || !isMemoRun(run) || run.createdBy === principal.userId;
}

export function isMemoRun(run: { subjectKey: string | null }): boolean {
  return run.subjectKey?.startsWith(MEMO_RUN_PREFIX) === true;
}

function seesEveryRun(principal: Principal): boolean {
  return principal.mode === 'dev' || principal.isAdmin;
}
