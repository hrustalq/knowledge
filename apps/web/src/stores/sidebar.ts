import { defineStore } from 'pinia'
import { getRailOpen, getRailWidth, setRailOpen, setRailWidth } from '@/lib/api'

/**
 * The rail's geometry: how wide it is, whether it is open, and — derived from
 * the width — how deep the page tree may indent before it has to start sliding.
 *
 * That last one is why width lives in a store rather than in the shell. The
 * tree window and the resize handle are not two features side by side: widening
 * the rail buys indent depth, and narrowing it spends depth back. Deriving the
 * budget here is what keeps them from ever disagreeing about a number.
 */

/** Narrower than this and a title has no room left after four levels of rail. */
export const RAIL_MIN = 208
/** Wider than this and the rail is competing with the page for the column. */
export const RAIL_MAX = 448
/** The 16rem in DESIGN.md — the width every other measurement was drawn against. */
export const RAIL_DEFAULT = 256

/** A detent at the default: drag near 16rem and it takes, so the rail is recoverable by hand. */
const SNAP = 14
/**
 * Drag past the minimum and the rail closes rather than fighting the pointer.
 * The gap between min and this is what makes it a decision instead of a twitch.
 */
const COLLAPSE_AT = RAIL_MIN - 44

/** One tree level: `ml-[13px]` plus the list's `pl-2`. */
export const TREE_INDENT = 21
/** Rail chrome before a title starts: 8px list padding either side, the 20px disclosure slot, the 8px trailing gutter. */
const TREE_CHROME = 44
/** Roughly eighteen characters — below this a title stops being a title and becomes an ellipsis. */
const TREE_MIN_TITLE = 128

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export const useSidebarStore = defineStore('sidebar', {
  state: () => ({
    width: clamp(getRailWidth() ?? RAIL_DEFAULT, RAIL_MIN, RAIL_MAX),
    open: getRailOpen(),
    /** True only while a pointer is on the handle: every rail transition steps aside for direct manipulation. */
    resizing: false,
  }),
  getters: {
    widthPx: (s) => `${s.width}px`,
    /**
     * How many levels of indent this width can spend and still leave a readable
     * title. Everything deeper is what the tree window slides to reach.
     */
    treeDepthBudget: (s) =>
      clamp(Math.floor((s.width - TREE_CHROME - TREE_MIN_TITLE) / TREE_INDENT), 1, 12),
  },
  actions: {
    toggle() {
      this.setOpen(!this.open)
    },
    setOpen(open: boolean) {
      this.open = open
      setRailOpen(open)
    },
    beginResize() {
      this.resizing = true
    },
    /**
     * Live drag. Width is held in state but never written to storage here —
     * a drag is a few hundred moves, and each one would be a cookie write.
     */
    dragTo(px: number) {
      if (px < COLLAPSE_AT) {
        // Closing by drag keeps the last real width, so releasing here and
        // reopening later returns the rail you had rather than a sliver.
        this.open = false
        return
      }
      this.open = true
      const next = clamp(px, RAIL_MIN, RAIL_MAX)
      this.width = Math.abs(next - RAIL_DEFAULT) < SNAP ? RAIL_DEFAULT : next
    },
    endResize() {
      this.resizing = false
      setRailWidth(this.width)
      setRailOpen(this.open)
    },
    /** Keyboard nudge on the handle, and the double-click reset. */
    nudge(delta: number) {
      this.open = true
      this.width = clamp(this.width + delta, RAIL_MIN, RAIL_MAX)
      setRailWidth(this.width)
      setRailOpen(true)
    },
    setWidth(px: number) {
      this.width = clamp(px, RAIL_MIN, RAIL_MAX)
      setRailWidth(this.width)
    },
  },
})
