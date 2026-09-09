<script setup lang="ts">
/**
 * The one way this app opens and closes a section.
 *
 * A panel that snaps to full height moves everything under it in a single
 * frame, and the reader has to re-find the line they were on. The reasoning
 * was already written into the import wizard's warning list; this is that
 * mechanism promoted so the rail widgets, the page tree, review threads and
 * the editor's expand block all open the same way.
 *
 * The height comes from `grid-template-rows: 0fr -> 1fr`, which is the only
 * technique that animates an *unknown* height without measuring it first. A
 * rail widget's body is a revision table, a graph canvas or an activity
 * feed — nothing here can know how tall the slot is, and a JS measure pass
 * would have to run before every open and would be wrong the moment the
 * content loaded.
 *
 * The inner element clips (`overflow: hidden; min-height: 0` — a grid item
 * will not shrink below its content without it) and carries a shorter fade, so
 * the content arrives *with* the box rather than being revealed by a moving
 * edge slicing across it.
 *
 * `unmount` (the default) is for bodies that cost something to keep alive —
 * the graph widget builds a force simulation and a canvas, and a rail that kept all seven
 * mounted would make the page slower to read for the sake of panels nobody
 * opened. Pass `:unmount="false"` where unmounting would lose state that
 * cannot be rebuilt: the editor's expand block keeps its ProseMirror content
 * DOM mounted, because dropping it desyncs the document.
 */
withDefaults(defineProps<{ open: boolean; unmount?: boolean }>(), { unmount: true })
</script>

<template>
  <!-- Kept mounted: the closed state is a class, so nothing is torn down. -->
  <div v-if="!unmount" class="kn-collapse" :class="{ 'kn-collapse-closed': !open }">
    <div class="kn-collapse-inner"><slot /></div>
  </div>

  <!-- Unmounted while closed. The Transition is what holds the body in the DOM
       for the length of the close, so it collapses instead of vanishing. -->
  <Transition v-else name="kn-collapse">
    <div v-if="open" class="kn-collapse">
      <div class="kn-collapse-inner"><slot /></div>
    </div>
  </Transition>
</template>
