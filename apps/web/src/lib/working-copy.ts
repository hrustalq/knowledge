/**
 * The editor's working copy: page edits that have not been published.
 *
 * Git's vocabulary, because it is the same idea. Publishing a revision is the
 * commit; until then the edits are *unstaged* — they belong to this browser and
 * nothing else can see them. Before this they lived only in component state, so
 * a reload, a crash or a closed laptop lid threw them away; now they are
 * written here as they are made and are waiting when the page is next opened.
 *
 * Keyed per workspace and page, with one slot per workspace for the page not
 * created yet. `localStorage`, not IndexedDB: a page is tens of kilobytes of
 * markdown, the write has to be synchronous to survive `pagehide`, and every
 * access is guarded because private modes and full quotas throw.
 */
import type { PageFields } from './page-source'

export interface WorkingCopy extends PageFields {
  v: 1
  documentId: string | null
  /**
   * The head the edits were made against. When the page has been published
   * since, restoring them silently would publish over someone else's revision.
   */
  baseRevisionId: string | null
  savedAt: number
}

const PREFIX = 'kn:unstaged:v1:'

export function workingCopyKey(workspaceId: string, documentId: string | null): string {
  return `${PREFIX}${workspaceId}:${documentId ?? 'new'}`
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function isWorkingCopy(value: unknown): value is WorkingCopy {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.v === 1 &&
    typeof v.title === 'string' &&
    typeof v.body === 'string' &&
    typeof v.category === 'string' &&
    typeof v.parentId === 'string' &&
    typeof v.projectId === 'string' &&
    Array.isArray(v.relations) &&
    typeof v.tags === 'string' &&
    typeof v.savedAt === 'number'
  )
}

export function readWorkingCopy(key: string): WorkingCopy | null {
  try {
    const raw = storage()?.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    // A shape this version does not recognise is not restored — offering a
    // half-understood draft back is worse than offering nothing.
    return isWorkingCopy(parsed) ? { ...parsed, message: typeof parsed.message === 'string' ? parsed.message : '' } : null
  } catch {
    return null
  }
}

/** False when the browser refused the write — the caller must not claim the edits are safe. */
export function writeWorkingCopy(key: string, copy: WorkingCopy): boolean {
  const store = storage()
  if (!store) return false
  try {
    store.setItem(key, JSON.stringify(copy))
    return true
  } catch {
    return false
  }
}

export function removeWorkingCopy(key: string): void {
  try {
    storage()?.removeItem(key)
  } catch {
    // Nothing to do: an unremovable copy is offered again and can be discarded then.
  }
}

/** Whether a page has unstaged edits waiting — for surfaces that link into the editor. */
export function hasWorkingCopy(workspaceId: string, documentId: string): boolean {
  return readWorkingCopy(workingCopyKey(workspaceId, documentId)) !== null
}
