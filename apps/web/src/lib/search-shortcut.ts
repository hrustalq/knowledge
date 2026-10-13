/**
 * The search sheet's keyboard and focus behaviour, shared by the app
 * (AppTopbar + SearchSheet) and the public site reader (SiteSearch). Store-
 * and router-free on purpose: the reader has neither.
 */

/**
 * Does this keydown open search? "/" when the user is not typing somewhere,
 * ⌘K / Ctrl+K anywhere but a rich editor — there ⌘K means "link this
 * selection", the convention in every editor people arrive from, and firing
 * search too opened both at once. Plain inputs keep the global shortcut.
 */
export function isSearchShortcut(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    return !target?.isContentEditable && !e.defaultPrevented
  }
  const typing =
    target !== null &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
  return !typing && e.key === '/'
}

/**
 * Focus for a sheet opened programmatically (a button elsewhere, "/" or ⌘K):
 * reka-ui has no SheetTrigger to hand focus back to on close. Left alone,
 * focus stays inside the dismissed dialog: keyboard users are stranded, and
 * the next "/" lands in the hidden query input as literal text instead of
 * reopening.
 *
 * Call `remember()` when the sheet opens, and bind `onCloseAutoFocus` to the
 * content's `@close-auto-focus` — restoring on a watcher races the dialog's
 * post-close focus handling and loses. Focus goes to the trigger when there
 * is one, else back where it was.
 */
export function createFocusReturn(triggerId: string) {
  let previous: HTMLElement | null = null
  return {
    remember() {
      if (typeof document !== 'undefined') previous = document.activeElement as HTMLElement | null
    },
    onCloseAutoFocus(e: Event) {
      e.preventDefault()
      const last = previous
      previous = null
      const trigger = document.getElementById(triggerId)
      const target = trigger ?? (last?.isConnected ? last : null)
      if (target && typeof target.focus === 'function') target.focus()
      else (document.activeElement as HTMLElement | null)?.blur()
    },
  }
}
