import { computed, toValue, type Component, type MaybeRefOrGetter, type WritableComputedRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * The page layer's vocabulary: four shapes, one measure each.
 *
 * Every route in this app except the auth cards is one of these four, and the
 * variant is the only thing a page has to declare about its own geometry. The
 * point is not tidiness — it is that a reader crossing thirty routes should not
 * have to re-find the title, the actions and the state on each one.
 *
 * - `prose`   — something read top to bottom. Capped at the 46rem measure the
 *               document renderer already uses, so a page *about* prose and a
 *               page *of* prose have the same line length. This is the one cap
 *               in the system, and it is a reading measure rather than a layout
 *               preference: past ~75 characters the eye loses the start of the
 *               next line.
 * - `list`    — a roster, table or feed. Takes the whole column: a row is
 *               scanned down its left edge, not read across, so the argument
 *               for a measure does not apply, and a table given less room than
 *               the window has starts truncating columns that had somewhere to
 *               go. This app uses the space it has.
 * - `detail`  — one subject plus a rail of facts about it. The column takes
 *               what the rail leaves, so it declares no measure of its own.
 * - `canvas`  — owns the viewport and scrolls something inside itself. Pairs
 *               with `meta.fill` on the route (see App.vue's two content modes);
 *               PageLayout asserts that pairing in dev, because the two facts
 *               have to agree and until now nothing checked.
 */
export type PageVariant = 'prose' | 'list' | 'detail' | 'canvas'

/**
 * The measure cap per variant, as a class rather than a token, because Tailwind
 * has to see the literal string to emit it.
 *
 * Only prose is capped. The other three are bounded by something real already —
 * a rail, the viewport, or the content's own columns — and a max-width there is
 * a second constraint fighting the true one, which shows up as a page hugging
 * the left of a wide display beside a band of nothing.
 */
export const PAGE_MEASURE: Record<PageVariant, string> = {
  prose: 'max-w-[46rem]',
  list: '',
  detail: '',
  canvas: '',
}

/** Whether this variant hands its scroll to something inside the page. */
export function isCanvas(variant: PageVariant): boolean {
  return variant === 'canvas'
}

export interface PageTab<K extends string = string> {
  key: K
  /** Already translated — every call site in this app resolves `t()` at render. */
  label: string
  /** Shown as a count badge. `null` means "not known yet", which draws nothing. */
  count?: number | null
  icon?: Component
}

/*
 * Tab and panel ids are derived rather than passed, so a consumer wiring
 * `aria-controls` cannot disagree with the strip about what the panel is
 * called. Both halves import these from here.
 */
export function tabId(key: string): string {
  return `kn-tab-${key}`
}
export function panelId(key: string): string {
  return `kn-panel-${key}`
}

/**
 * Binds a tab selection to `?tab=` so a link can point at one.
 *
 * `replace`, never `push`: choosing a tab changes what you are looking at, it
 * is not a place you navigated to. Pushing would make Back walk every tab you
 * tried on the way to the one you wanted, which is the behaviour the saved
 * filter rail already rejected for `?view=`.
 *
 * The default tab clears the parameter instead of writing it. A URL that says
 * `?tab=config` when `config` is what you get anyway is noise in something
 * people paste to each other.
 */
export function usePageTabs<K extends string>(
  tabs: MaybeRefOrGetter<readonly PageTab<K>[]>,
  fallback: K,
  param = 'tab',
): WritableComputedRef<K> {
  const route = useRoute()
  const router = useRouter()

  return computed<K>({
    get() {
      const raw = route.query[param]
      const found = toValue(tabs).some((t) => t.key === raw)
      return found ? (raw as K) : fallback
    },
    set(key) {
      const query = { ...route.query }
      if (key === fallback) delete query[param]
      else query[param] = key
      void router.replace({ query })
    },
  })
}

export interface RailWidget<K extends string = string> {
  id: K
  /** Already translated. */
  label: string
  icon: Component
  /**
   * Whether this widget offers a maximize control. A panel authored for a
   * full-width page (a revision table, a diff) needs room the rail does not
   * have; one that fits comfortably would only be offering a bigger version of
   * the same thing.
   */
  expandable?: boolean
}
