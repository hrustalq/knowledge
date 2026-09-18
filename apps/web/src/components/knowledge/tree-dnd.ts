/**
 * Feature 32: drag-and-drop for the page tree.
 *
 * One controller per tree, provided by the tree's root and injected by every
 * row. The two trees (the rail's `SidebarTreeNode`, the index's
 * `DocumentTreeNode`) sit in different materials but the gesture is one
 * implementation, for the same reason their lazy loading already is: two copies
 * of "what does dropping here mean" is how they come to disagree.
 *
 * Pointer Events rather than HTML5 drag-and-drop. HTML5 hands you a drag image
 * you cannot style, no hook to auto-scroll a container, and touch support that
 * varies by browser — and none of its machinery helps the keyboard path, which
 * we need anyway for WCAG 2.2 §2.5.7.
 */
import {
  computed,
  inject,
  onBeforeUnmount,
  provide,
  reactive,
  ref,
  watchEffect,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue'
import { useDocumentsStore } from '@/stores/documents'

export type DropPlacement = 'before' | 'after' | 'inside'

/** A resolved destination: not "which row", but which run and which slot in it. */
export interface TreeDropTarget {
  /** The row the cursor is over. Empty for the slot past the last row. */
  rowId: string
  placement: DropPlacement
  parentId: string | null
  /** The sibling this lands above; null appends last. */
  beforeId: string | null
  /** Indent level the drop indicator draws at. */
  depth: number
}

export interface TreeDragState {
  id: string
  title: string
  mode: 'pointer' | 'keyboard'
  /** Viewport coordinates of the ghost. Unused in keyboard mode. */
  x: number
  y: number
  target: TreeDropTarget | null
  /** Target would put the page inside itself. */
  invalid: boolean
}

export interface TreeRowHandle {
  id: string
  parentId: string | null
  depth: number
  title: string
  el: HTMLElement
  hasChildren: boolean
  isExpanded: () => boolean
  setExpanded: (open: boolean) => void
}

/** Pixels the pointer must travel before a press becomes a drag, not a click. */
const DRAG_THRESHOLD = 4
/** Hover this long over a collapsed branch and it opens. */
const AUTO_EXPAND_MS = 600
/** Distance from a scroll edge at which auto-scroll engages. */
const SCROLL_EDGE = 36
/** Fastest auto-scroll, in px per frame, reached at the very edge. */
const SCROLL_MAX = 14

export interface TreeDnd {
  state: Ref<TreeDragState | null>
  /** Set on an aborted keyboard drag so the row can restore focus. */
  register: (row: TreeRowHandle) => void
  unregister: (id: string) => void
  /** True while this id, or an ancestor of it, has a move in flight. */
  isLocked: (id: string) => boolean
  beginPointer: (row: TreeRowHandle, ev: PointerEvent) => void
  beginKeyboard: (row: TreeRowHandle) => void
  /** Returns true when the key was one this controller consumes. */
  onKeydown: (ev: KeyboardEvent) => boolean
  commit: () => void
  cancel: () => void
}

const TreeDndKey: InjectionKey<TreeDnd> = Symbol('kn-tree-dnd')

export function useTreeDnd(): TreeDnd | null {
  return inject(TreeDndKey, null)
}

/**
 * Create the controller and provide it. Called by a tree root, which must also
 * mark its scrolling element with `data-tree-scroll` — auto-scroll walks up
 * from the row rather than guessing which ancestor scrolls.
 */
export function provideTreeDnd(
  onError: (message: string) => void,
  /**
   * The tree's horizontal window, when it has one. The rail slides the list
   * left past a depth budget, so a drop into a deep level has to travel there
   * the way a click does — otherwise the row being aimed at is off its own
   * left edge by the time the indicator lands on it.
   */
  reveal?: (depth: number) => void,
): TreeDnd {
  const store = useDocumentsStore()
  const state = ref<TreeDragState | null>(null)
  const rows = new Map<string, TreeRowHandle>()

  /** Branches this drag opened, newest last, to be closed again if abandoned. */
  let autoExpanded: string[] = []
  let expandTimer: ReturnType<typeof setTimeout> | null = null
  let expandCandidate: string | null = null
  let scrollFrame: number | null = null
  let scrollEl: HTMLElement | null = null
  let pending: { row: TreeRowHandle; x: number; y: number } | null = null
  let lastFocused: HTMLElement | null = null

  // ---------------------------------------------------------------- geometry

  /** Registered rows top to bottom. Registration order is mount order, which a move invalidates. */
  function orderedRows(): TreeRowHandle[] {
    return [...rows.values()]
      .filter((r) => r.el.isConnected)
      .sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top)
  }

  /** Rows that are not the dragged page and not inside it — the only legal landing sites. */
  function landableRows(dragId: string): TreeRowHandle[] {
    return orderedRows().filter((r) => r.id !== dragId && !store.isDescendantOf(r.id, dragId))
  }

  function nextSiblingOf(row: TreeRowHandle): string | null {
    const run = store.siblingIdsOf(row.parentId)
    return run[run.indexOf(row.id) + 1] ?? null
  }

  function firstChildOf(id: string): string | null {
    return store.siblingIdsOf(id)[0] ?? null
  }

  /**
   * Turn a row plus a vertical position within it into a destination.
   *
   * The top and bottom quarters insert among the row's siblings and the middle
   * half nests — the rule every file manager uses, so it needs no teaching.
   * The one refinement: below an *expanded* row, "after" means its first child,
   * because that is the slot the gap visually belongs to. Landing such a drop
   * on the row's next sibling instead is the single most common way a tree
   * drag surprises the person doing it.
   */
  function resolve(row: TreeRowHandle, rel: number): TreeDropTarget {
    if (rel < 0.25) {
      return { rowId: row.id, placement: 'before', parentId: row.parentId, beforeId: row.id, depth: row.depth }
    }
    if (rel >= 0.75) {
      const opened = row.hasChildren && row.isExpanded()
      return opened
        ? { rowId: row.id, placement: 'after', parentId: row.id, beforeId: firstChildOf(row.id), depth: row.depth + 1 }
        : {
            rowId: row.id,
            placement: 'after',
            parentId: row.parentId,
            beforeId: nextSiblingOf(row),
            depth: row.depth,
          }
    }
    return { rowId: row.id, placement: 'inside', parentId: row.id, beforeId: null, depth: row.depth + 1 }
  }

  function hitTest(x: number, y: number): TreeDropTarget | null {
    const drag = state.value
    if (!drag) return null
    for (const row of landableRows(drag.id)) {
      const r = row.el.getBoundingClientRect()
      if (y < r.top || y >= r.bottom || x < r.left || x > r.right) continue
      return resolve(row, (y - r.top) / r.height)
    }
    return null
  }

  /**
   * Apply a freshly resolved target.
   *
   * The window travels only for a keyboard drag. Under the pointer it must not:
   * panning the list sideways changes which row sits under a stationary cursor,
   * which resolves a different target, which pans again — the target oscillates
   * and every frame invalidates layout for a rect pass that has to be redone.
   * The cursor is the authority in a pointer drag, so the view holds still.
   */
  function setTarget(drag: TreeDragState, target: TreeDropTarget | null): void {
    drag.target = target
    drag.invalid = invalidFor(drag.id, target)
    if (target && drag.mode === 'keyboard') reveal?.(target.depth)
  }

  /** A destination inside the page being dragged would detach it from the tree. */
  function invalidFor(dragId: string, target: TreeDropTarget | null): boolean {
    if (!target?.parentId) return false
    return target.parentId === dragId || store.isDescendantOf(target.parentId, dragId)
  }

  // ------------------------------------------------------------ auto-expand

  function isOnPathTo(id: string, target: TreeDropTarget | null): boolean {
    if (!target?.parentId) return false
    return target.parentId === id || store.isDescendantOf(target.parentId, id)
  }

  /** Close branches this drag opened that the cursor has since left. */
  function pruneAutoExpanded(target: TreeDropTarget | null): void {
    const keep: string[] = []
    for (const id of autoExpanded) {
      if (isOnPathTo(id, target)) keep.push(id)
      else rows.get(id)?.setExpanded(false)
    }
    autoExpanded = keep
  }

  function scheduleExpand(target: TreeDropTarget | null): void {
    const id = target?.placement === 'inside' ? target.parentId : null
    if (id === expandCandidate) return
    expandCandidate = id
    if (expandTimer) clearTimeout(expandTimer)
    expandTimer = null
    if (!id) return
    const row = rows.get(id)
    if (!row?.hasChildren || row.isExpanded()) return
    expandTimer = setTimeout(() => {
      // Re-check: the pointer may have moved on while the timer ran.
      if (expandCandidate !== id) return
      row.setExpanded(true)
      autoExpanded.push(id)
    }, AUTO_EXPAND_MS)
  }

  // ------------------------------------------------------------ auto-scroll

  /** How fast the container should scroll right now; 0 outside the edge zone. */
  function scrollVelocity(y: number): number {
    if (!scrollEl) return 0
    const r = scrollEl.getBoundingClientRect()
    const fromTop = y - r.top
    const fromBottom = r.bottom - y
    if (fromTop < SCROLL_EDGE) return -Math.ceil(((SCROLL_EDGE - fromTop) / SCROLL_EDGE) * SCROLL_MAX)
    if (fromBottom < SCROLL_EDGE) return Math.ceil(((SCROLL_EDGE - fromBottom) / SCROLL_EDGE) * SCROLL_MAX)
    return 0
  }

  /**
   * Auto-scroll runs only while the pointer is actually in an edge zone, and
   * stops the moment it leaves.
   *
   * It used to run for the whole drag, which meant a full `getBoundingClientRect`
   * pass over every row on every frame — a forced synchronous layout sixty times
   * a second, for the entire time a page was held. On the pages index, where a
   * force-directed graph is simulating alongside it, that was enough to lock the
   * main thread. Nothing needs re-testing while the list is not moving: the
   * pointer's own events already cover that.
   */
  function step(): void {
    const drag = state.value
    if (!drag || drag.mode !== 'pointer' || !scrollEl) return stopScrolling()
    const dy = scrollVelocity(drag.y)
    if (dy === 0) return stopScrolling()
    scrollEl.scrollTop += dy
    // The rows moved under a stationary cursor, so the target did too.
    setTarget(drag, hitTest(drag.x, drag.y))
    scrollFrame = requestAnimationFrame(step)
  }

  function stopScrolling(): void {
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
    scrollFrame = null
  }

  function syncScrolling(y: number): void {
    if (scrollVelocity(y) === 0) stopScrolling()
    else if (scrollFrame === null) scrollFrame = requestAnimationFrame(step)
  }

  // ---------------------------------------------------------------- pointer

  function onPointerMove(ev: PointerEvent): void {
    if (pending && !state.value) {
      const far = Math.hypot(ev.clientX - pending.x, ev.clientY - pending.y) >= DRAG_THRESHOLD
      if (!far) return
      start(pending.row, 'pointer', ev.clientX, ev.clientY)
    }
    const drag = state.value
    if (!drag) return
    ev.preventDefault()
    drag.x = ev.clientX
    drag.y = ev.clientY
    const target = hitTest(ev.clientX, ev.clientY)
    setTarget(drag, target)
    pruneAutoExpanded(target)
    scheduleExpand(target)
    syncScrolling(ev.clientY)
  }

  function onPointerUp(): void {
    if (state.value?.mode === 'pointer') commit()
    else teardownPointer()
  }

  function teardownPointer(): void {
    pending = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', cancel)
  }

  function beginPointer(row: TreeRowHandle, ev: PointerEvent): void {
    if (ev.button !== 0 || state.value || isLocked(row.id)) return
    pending = { row, x: ev.clientX, y: ev.clientY }
    window.addEventListener('pointermove', onPointerMove, { passive: false })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', cancel)
  }

  // --------------------------------------------------------------- keyboard

  /**
   * Every slot the page could land in, top to bottom: one above each landable
   * row, plus one past the end at root level. ↑/↓ walk this; →/← re-nest
   * within the slot the way an outliner's indent keys do.
   */
  function slots(dragId: string): TreeDropTarget[] {
    const ordered = landableRows(dragId)
    const out: TreeDropTarget[] = ordered.map((r) => ({
      rowId: r.id,
      placement: 'before' as const,
      parentId: r.parentId,
      beforeId: r.id,
      depth: r.depth,
    }))
    out.push({ rowId: '', placement: 'after', parentId: null, beforeId: null, depth: 0 })
    return out
  }

  function sameSlot(a: TreeDropTarget | null, b: TreeDropTarget): boolean {
    return a?.parentId === b.parentId && a?.beforeId === b.beforeId
  }

  function moveSlot(delta: number): void {
    const drag = state.value
    if (!drag) return
    const all = slots(drag.id)
    const at = all.findIndex((s) => sameSlot(drag.target, s))
    const next = all[Math.min(Math.max((at === -1 ? 0 : at) + delta, 0), all.length - 1)]
    if (next) setTarget(drag, { ...next })
  }

  /** Nest one level deeper: become the last child of the row above this slot. */
  function indent(): void {
    const drag = state.value
    if (!drag?.target) return
    const ordered = landableRows(drag.id)
    const index = ordered.findIndex((r) => r.id === drag.target?.beforeId)
    const above = index === -1 ? ordered[ordered.length - 1] : ordered[index - 1]
    if (!above || above.id === drag.target.parentId) return
    setTarget(drag, {
      rowId: above.id,
      placement: 'inside',
      parentId: above.id,
      beforeId: null,
      depth: above.depth + 1,
    })
  }

  /** Outdent: become the sibling that follows the current parent. */
  function outdent(): void {
    const drag = state.value
    if (!drag?.target?.parentId) return
    const parent = rows.get(drag.target.parentId)
    if (!parent) return
    setTarget(drag, {
      rowId: parent.id,
      placement: 'after',
      parentId: parent.parentId,
      beforeId: nextSiblingOf(parent),
      depth: parent.depth,
    })
  }

  function beginKeyboard(row: TreeRowHandle): void {
    if (state.value || isLocked(row.id)) return
    lastFocused = row.el.querySelector<HTMLElement>('a,button') ?? row.el
    const drag = start(row, 'keyboard', 0, 0)
    // Open on the slot the page already occupies, so the first arrow press is
    // a step from where it is rather than a jump to the top of the tree.
    drag.target = {
      rowId: row.id,
      placement: 'before',
      parentId: row.parentId,
      beforeId: nextSiblingOf(row),
      depth: row.depth,
    }
  }

  function onKeydown(ev: KeyboardEvent): boolean {
    if (!state.value || state.value.mode !== 'keyboard') return false
    switch (ev.key) {
      case 'ArrowDown':
        moveSlot(1)
        break
      case 'ArrowUp':
        moveSlot(-1)
        break
      case 'ArrowRight':
        indent()
        break
      case 'ArrowLeft':
        outdent()
        break
      case 'Enter':
      case ' ':
        commit()
        break
      case 'Escape':
        cancel()
        break
      default:
        return false
    }
    ev.preventDefault()
    return true
  }

  // ------------------------------------------------------------ lifecycle

  function start(row: TreeRowHandle, mode: 'pointer' | 'keyboard', x: number, y: number): TreeDragState {
    const drag: TreeDragState = { id: row.id, title: row.title, mode, x, y, target: null, invalid: false }
    state.value = drag
    store.beginDrag()
    scrollEl = row.el.closest<HTMLElement>('[data-tree-scroll]')
    if (mode === 'pointer') document.body.classList.add('kn-tree-dragging')
    window.addEventListener('keydown', onEscape, true)
    return drag
  }

  function onEscape(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && state.value?.mode === 'pointer') {
      ev.preventDefault()
      cancel()
    }
  }

  function finish(): void {
    if (expandTimer) clearTimeout(expandTimer)
    expandTimer = null
    expandCandidate = null
    stopScrolling()
    scrollEl = null
    document.body.classList.remove('kn-tree-dragging')
    window.removeEventListener('keydown', onEscape, true)
    teardownPointer()
    state.value = null
    store.endDrag()
  }

  function cancel(): void {
    // Nothing was dropped, so nothing this drag opened should stay open.
    pruneAutoExpanded(null)
    autoExpanded = []
    const restore = lastFocused
    lastFocused = null
    finish()
    restore?.focus()
  }

  function commit(): void {
    const drag = state.value
    if (!drag) return teardownPointer()
    const { id, target, invalid } = drag
    const restore = lastFocused
    lastFocused = null
    // Branches on the way to the drop stay open — that is where the page went.
    pruneAutoExpanded(target)
    autoExpanded = []
    finish()
    restore?.focus()
    if (!target || invalid) return
    void store.moveDocument(id, target.parentId, target.beforeId).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : String(err))
    })
  }

  function isLocked(id: string): boolean {
    return store.moving.some((movingId) => movingId === id || store.isDescendantOf(id, movingId))
  }

  const dnd: TreeDnd = {
    state,
    register: (row) => rows.set(row.id, row),
    unregister: (id) => rows.delete(id),
    isLocked,
    beginPointer,
    beginKeyboard,
    onKeydown,
    commit,
    cancel,
  }
  provide(TreeDndKey, dnd)
  return dnd
}

export interface TreeRowDnd {
  /**
   * Bind with `:ref`. The controller hit-tests against this element's rect, and
   * scopes bubbling events to it.
   */
  setEl: (el: Element | { $el?: unknown } | null) => void
  /** This row is the page being dragged. */
  isSource: ComputedRef<boolean>
  /** This row, or an ancestor, has a move in flight. */
  isLocked: ComputedRef<boolean>
  /** An insertion line draws above / below this row. */
  dropBefore: ComputedRef<boolean>
  dropAfter: ComputedRef<boolean>
  /** The page would nest into this row. */
  dropInside: ComputedRef<boolean>
  /** Indent, in px, that the insertion line is inset by. */
  indicatorInset: ComputedRef<number>
  onPointerdown: (ev: PointerEvent) => void
  /** `canGrab` is the caller's edit permission: without it Space is not a grab. */
  onKeydown: (ev: KeyboardEvent, canGrab: boolean) => void
  /** Start a keyboard drag from this row. */
  grab: () => void
}

/**
 * The row half of the gesture: registers itself with the tree's controller and
 * reports back what it should be drawing.
 *
 * The handle is reactive rather than a snapshot because a move rewrites exactly
 * the fields the controller resolves drops against — a row that kept the
 * `parentId` it had at mount would, after one drag, offer its old run as a
 * destination for the next.
 */
export function useTreeDndRow(opts: {
  id: string
  title: () => string
  parentId: () => string | null
  depth: () => number
  hasChildren: () => boolean
  open: Ref<boolean>
  /** Pixels of indent per level, so the insertion line lands on the row's own rail. */
  indent: number
}): TreeRowDnd {
  const dnd = useTreeDnd()
  const el = ref<HTMLElement | null>(null)

  const handle = reactive({
    id: opts.id,
    title: opts.title(),
    parentId: opts.parentId(),
    depth: opts.depth(),
    hasChildren: opts.hasChildren(),
    el: null as unknown as HTMLElement,
    isExpanded: () => opts.open.value,
    setExpanded: (open: boolean) => {
      opts.open.value = open
    },
  }) as TreeRowHandle

  if (dnd) {
    watchEffect(() => {
      handle.title = opts.title()
      handle.parentId = opts.parentId()
      handle.depth = opts.depth()
      handle.hasChildren = opts.hasChildren()
      if (!el.value) return
      handle.el = el.value
      dnd.register(handle)
    })
    onBeforeUnmount(() => dnd.unregister(opts.id))
  }

  const drag = computed(() => dnd?.state.value ?? null)
  const targeted = computed(() => (drag.value?.target?.rowId === opts.id ? drag.value.target : null))
  const live = computed(() => targeted.value !== null && !drag.value?.invalid)

  /**
   * Rows nest, so every pointerdown and keydown inside a child bubbles through
   * all of its ancestor rows and each one's handler runs. Unscoped, grabbing a
   * deep page starts a drag of its outermost ancestor, and one arrow press
   * during a keyboard drag steps as many slots as the page is deep. Only the
   * innermost row acts.
   */
  function isInnermost(ev: Event): boolean {
    return (ev.target as HTMLElement | null)?.closest('[data-tree-row]') === el.value
  }

  return {
    setEl: (node) => {
      const element = node && '$el' in node ? node.$el : node
      el.value = element instanceof HTMLElement ? element : null
    },
    isSource: computed(() => drag.value?.id === opts.id),
    isLocked: computed(() => dnd?.isLocked(opts.id) ?? false),
    dropBefore: computed(() => live.value && targeted.value?.placement === 'before'),
    dropAfter: computed(() => live.value && targeted.value?.placement === 'after'),
    dropInside: computed(() => live.value && targeted.value?.placement === 'inside'),
    indicatorInset: computed(() => {
      const target = targeted.value
      if (!target) return 0
      // An insertion line at a deeper level than the row it sits against is how
      // "into this branch" reads without a second visual language for it.
      return Math.max(0, target.depth - opts.depth()) * opts.indent
    }),
    onPointerdown: (ev) => {
      if (!dnd || !el.value || !isInnermost(ev)) return
      // The chevron and the row menu are controls, not grips. Dragging from
      // them would make every disclosure click a potential move.
      if ((ev.target as HTMLElement | null)?.closest('[data-no-drag]')) return
      dnd.beginPointer(handle, ev)
    },
    onKeydown: (ev, canGrab) => {
      if (!dnd || !isInnermost(ev)) return
      if (dnd.onKeydown(ev)) return
      // Space on the focused page title grabs it. The title link is the row's
      // existing tab stop, so the gesture costs no new ones — a tree that added
      // a second focusable element per row would double the length of every tab
      // traversal of the rail to serve one gesture.
      if (canGrab && ev.key === ' ' && (ev.target as HTMLElement | null)?.tagName === 'A' && el.value) {
        ev.preventDefault()
        dnd.beginKeyboard(handle)
      }
    },
    grab: () => {
      if (dnd && el.value) dnd.beginKeyboard(handle)
    },
  }
}
