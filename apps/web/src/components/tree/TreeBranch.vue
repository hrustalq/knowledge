<script setup lang="ts">
/**
 * The children of a TreeRow: the indent rail, and placeholders while they load.
 *
 * The branch grows out of its parent row rather than appearing beneath it: on
 * a rail this dense, a subtree arriving in one frame shifts every row below it
 * and you lose the page you were aiming at.
 */
import { Collapse } from '@/components/ui/collapse'

defineProps<{
  open: boolean
  /** How many children are coming: the placeholder count while none are here yet. */
  childCount: number
  /** False while the children have not arrived. */
  loaded: boolean
}>()
</script>

<template>
  <Collapse :open="open">
    <!-- TREE_INDENT (lib/tree-window) is this ml plus this pl. -->
    <ul class="ml-[13px] border-l border-sidebar-border pl-2">
      <slot />
      <!-- Placeholder rows sized to the real ones, so the branch does not
           open onto nothing and then jolt when the children land. -->
      <li v-if="!loaded" class="space-y-1 py-1 pl-1" aria-hidden="true">
        <div v-for="i in Math.min(childCount, 3)" :key="i" class="h-4 w-full animate-pulse rounded bg-sidebar-accent" />
      </li>
    </ul>
  </Collapse>
</template>
