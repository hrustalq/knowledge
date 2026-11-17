/**
 * #1071: below `xl` (#1046) a list-and-detail page stacks its detail pane
 * under the list, so a pick changes nothing on screen unless the detail is brought up.
 *
 * Scrolls only the page's own scroller (`<main>`). `scrollIntoView` would also
 * scroll every clipped ancestor that can still move by script — the shell's
 * `overflow: hidden` column among them — and slide the trail row under the
 * top bar with no way back by touch.
 */
export function revealStackedPane(el: HTMLElement | null | undefined): void {
  if (!el || !window.matchMedia('(width < 80rem)').matches) return
  const scroller = el.closest('main')
  if (!scroller) return
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  scroller.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' })
}
