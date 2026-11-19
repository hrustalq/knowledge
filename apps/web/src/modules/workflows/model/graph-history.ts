import { computed, ref } from 'vue'
import type { WorkflowGraph } from '@knowledge/contracts'

/** Two edits to the same thing this close together are one undo step. */
export const COALESCE_MS = 1000
const CAPACITY = 100

/**
 * Undo and redo for the builder's draft graph (#1246).
 *
 * Snapshots, not inverse operations: every canvas edit already produces a new
 * graph object (nothing mutates one in place), so the stack holds references
 * and an undo is a swap. An operation log would need an inverse per edit kind
 * and would still have to agree with the architect replacing the whole graph.
 *
 * `key` coalesces a burst — typing a prompt, nudging a step with the arrow
 * keys — into the one entry a person thinks of as "that edit". Discrete edits
 * (add, connect, delete, drag) pass no key and always get their own entry.
 */
export function graphHistory(
  read: () => WorkflowGraph | undefined,
  write: (graph: WorkflowGraph) => void,
  now: () => number = Date.now,
) {
  const past: WorkflowGraph[] = []
  const future: WorkflowGraph[] = []
  // The stacks are plain arrays; this counter is what `canUndo` re-reads.
  const version = ref(0)
  let lastKey: string | null = null
  let lastAt = 0

  function apply(next: WorkflowGraph, key?: string) {
    const current = read()
    if (!current) return
    const at = now()
    if (!key || key !== lastKey || at - lastAt >= COALESCE_MS) {
      past.push(current)
      if (past.length > CAPACITY) past.shift()
    }
    future.length = 0
    lastKey = key ?? null
    lastAt = at
    write(next)
    version.value++
  }

  function move(from: WorkflowGraph[], to: WorkflowGraph[]) {
    const current = read()
    const target = from.pop()
    if (!current || !target) return
    to.push(current)
    lastKey = null
    write(target)
    version.value++
  }

  function reset() {
    past.length = 0
    future.length = 0
    lastKey = null
    version.value++
  }

  return {
    apply,
    undo: () => move(past, future),
    redo: () => move(future, past),
    reset,
    canUndo: computed(() => version.value >= 0 && past.length > 0),
    canRedo: computed(() => version.value >= 0 && future.length > 0),
  }
}
