import type { PublishMode } from '@knowledge/contracts'

/**
 * Which working branch the editor asks for when it opens a page (#958):
 * - `none`: a `?branch=` link names its branch, and a private draft page is private already;
 * - `mine`: `review` mode, the caller's working branch, created on first ask (#474);
 * - `existing`: `direct` mode, only a working branch that already holds unpublished
 *   work, so nobody's draft is stranded by the switch; otherwise the default branch.
 */
export function workingBranchAsk(page: { requestedBranch: string | null; isDraftPage: boolean; mode: PublishMode }): 'none' | 'mine' | 'existing' {
  if (page.requestedBranch || page.isDraftPage) return 'none'
  return page.mode === 'direct' ? 'existing' : 'mine'
}
