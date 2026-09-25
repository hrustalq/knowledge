/**
 * Keeps a page's unstaged edits in the working copy (`lib/working-copy`) while
 * it is being written.
 *
 * One stream of page states drives both answers the editor needs: whether
 * anything is unstaged (immediately, for the header) and what to store (once
 * the writing pauses, so a burst of typing is one write, not forty). Leaving
 * the tab — `pagehide`, or the tab going to the background, which on mobile is
 * often the last event a page ever gets — writes at once.
 *
 * Writing only what differs from the published page is what makes the copy
 * trustworthy: undo your way back to the head and the stored copy is removed,
 * so "unstaged" never means "a draft identical to what is already there".
 */
import { onBeforeUnmount, onMounted, readonly, ref, type Ref } from 'vue'
import {
  Subscription,
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  filter,
  fromEvent,
  map,
  merge,
  share,
} from 'rxjs'
import { fromWatch } from '@/lib/rx-vue'
import { samePage, type PageFields } from '@/lib/page-source'
import { removeWorkingCopy, writeWorkingCopy } from '@/lib/working-copy'

export interface WorkingCopyOptions {
  /** Storage slot; `null` while the page is loading, which suspends writing. */
  key: () => string | null
  /** What is on screen now. Must read every field it returns, so the watch tracks it. */
  fields: () => PageFields
  /** The published page the edits are measured against; `null` while loading. */
  base: () => PageFields | null
  documentId: () => string | null
  baseRevisionId: () => string | null
  /** Called before an immediate write, so a pending editor debounce is not left behind. */
  beforeFlush?: () => void
  /** Pause between the last change and the write. */
  dueTime?: number
}

export function useWorkingCopy(options: WorkingCopyOptions) {
  const unstaged = ref(false)
  /** When the edits were last written, or `null` when there is nothing stored. */
  const savedAt = ref<number | null>(null)
  /** The browser refused the last write: the edits are on screen only. */
  const persistFailed = ref(false)

  interface Snapshot {
    key: string | null
    fields: PageFields
    base: PageFields | null
  }
  let latest: Snapshot | null = null
  /**
   * Whether the stored copy is this session's to remove. A clean page must not
   * delete a copy it never wrote: a second tab on the same page, or this one
   * while it is still offering a stale copy back, would otherwise wipe edits
   * the moment it was closed — `pagehide` flushes, and a clean flush removes.
   */
  let owned = false

  function write(snapshot: Snapshot | null): boolean {
    if (!snapshot?.key || !snapshot.base) return true
    if (samePage(snapshot.fields, snapshot.base)) {
      if (owned) removeWorkingCopy(snapshot.key)
      owned = false
      savedAt.value = null
      persistFailed.value = false
      return true
    }
    const at = Date.now()
    const ok = writeWorkingCopy(snapshot.key, {
      v: 1,
      ...snapshot.fields,
      documentId: options.documentId(),
      baseRevisionId: options.baseRevisionId(),
      savedAt: at,
    })
    persistFailed.value = !ok
    if (ok) {
      owned = true
      savedAt.value = at
    }
    return ok
  }

  const subscriptions = new Subscription()

  // Client only: the SSR pass has no storage and no tab to leave.
  onMounted(() => {
    const snapshot$ = combineLatest({
      key: fromWatch(options.key),
      fields: fromWatch(options.fields),
      base: fromWatch(options.base),
    }).pipe(share())

    subscriptions.add(
      snapshot$
        .pipe(
          map(({ fields, base }) => base !== null && !samePage(fields, base)),
          distinctUntilChanged(),
        )
        .subscribe((value) => (unstaged.value = value)),
    )

    subscriptions.add(
      snapshot$.subscribe((snapshot) => {
        latest = snapshot
      }),
    )

    subscriptions.add(snapshot$.pipe(debounceTime(options.dueTime ?? 600)).subscribe(write))

    const leaving$ = merge(
      fromEvent(window, 'pagehide'),
      fromEvent(document, 'visibilitychange').pipe(filter(() => document.visibilityState === 'hidden')),
    )
    subscriptions.add(leaving$.subscribe(() => flush()))
  })

  onBeforeUnmount(() => subscriptions.unsubscribe())

  /**
   * Write now. Returns whether the edits are safe — stored, or nothing to store
   * — which is what decides if leaving still needs the browser's own prompt.
   */
  function flush(): boolean {
    options.beforeFlush?.()
    return write(latest)
  }

  /** The page took a stored copy back into the editor: from here it is this session's. */
  function adopt(stored: { savedAt: number }): void {
    owned = true
    savedAt.value = stored.savedAt
  }

  /** Forget the stored copy for `key`. The page resets its own fields. */
  function discard(key: string | null = latest?.key ?? null): void {
    if (key) removeWorkingCopy(key)
    owned = false
    savedAt.value = null
    persistFailed.value = false
  }

  /**
   * The edits are gone for good — published, or thrown away on the way out.
   * Stops the streams as well as removing the copy: a write still waiting out
   * its pause would otherwise land after the publish and store the edits again,
   * measured against a head that no longer exists.
   */
  function settle(): void {
    subscriptions.unsubscribe()
    discard()
    unstaged.value = false
  }

  return {
    unstaged: readonly(unstaged) as Readonly<Ref<boolean>>,
    savedAt: readonly(savedAt) as Readonly<Ref<number | null>>,
    persistFailed: readonly(persistFailed) as Readonly<Ref<boolean>>,
    flush,
    adopt,
    discard,
    settle,
  }
}
