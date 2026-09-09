import type { InjectionKey } from 'vue'

/**
 * The page tree's horizontal window.
 *
 * Every level of the tree spends 21px on indent, so on a 16rem rail a page five
 * levels down has about forty pixels left for its title — which is not a title,
 * it is an ellipsis. Rather than give up the indent (it is the only thing
 * drawing the containment path) the tree slides: reaching past the depth the
 * rail can afford pans the whole list left, so the level you are working in
 * gets its full width back and its ancestors pass under a faded left edge.
 *
 * The pane owns the window and the nodes report into it. Only gestures report —
 * a node auto-expanding because the active document happens to live under it is
 * not a request to look there, and letting those fire would hand the window to
 * whichever ancestor's watcher ran last.
 */
export interface TreeWindow {
  /** A gesture asked to see this depth: bring it inside the window. */
  reveal(depth: number): void
  /** A gesture closed this level: the window need go no deeper than here. */
  retreat(depth: number): void
}

export const TreeWindowKey: InjectionKey<TreeWindow> = Symbol('kn-tree-window')
