<script setup lang="ts">
/**
 * One widget in the page rail.
 *
 * Collapsed, it is a single scannable row: what it is, and the one fact that
 * tells you whether to open it — how many revisions, how many open merge
 * requests, when something last happened. That preview is the whole reason the
 * rail is a stack rather than tabs: with tabs, three of the four answers are
 * always hidden behind a click.
 *
 * The body mounts only while open. Some of these panels are expensive (the
 * graph builds a Cytoscape instance), and a rail that instantiated all four on
 * every page load would make the page slower to read for the sake of things
 * nobody asked to see.
 */
import type { Component } from 'vue'
import { ChevronRight, Maximize2 } from 'lucide-vue-next'

defineProps<{
  icon: Component
  title: string
  /** The one fact worth showing while collapsed. */
  preview?: string | null
  open: boolean
  /** Hide the maximize control for panels that fit the rail comfortably. */
  expandable?: boolean
}>()
const emit = defineEmits<{ 'update:open': [boolean]; expand: [] }>()
</script>

<template>
  <section class="overflow-hidden rounded-lg border bg-card">
    <div class="flex items-center">
      <button
        class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
        :aria-expanded="open"
        @click="emit('update:open', !open)"
      >
        <ChevronRight
          class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150"
          :class="open ? 'rotate-90' : ''"
        />
        <component :is="icon" class="size-4 shrink-0 text-muted-foreground" />
        <span class="shrink-0 text-sm font-medium">{{ title }}</span>
        <span v-if="preview" class="ml-auto truncate pl-2 text-xs text-muted-foreground">
          {{ preview }}
        </span>
      </button>
      <button
        v-if="open && expandable"
        class="mr-1.5 shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        :title="`Open ${title} in a larger view`"
        :aria-label="`Open ${title} in a larger view`"
        @click="emit('expand')"
      >
        <Maximize2 class="size-3.5" />
      </button>
    </div>

    <!-- Scrolls in both directions: a panel built for a full-width page (the
         revision table) belongs inside the card, not spilling out of it. -->
    <div v-if="open" class="max-h-[26rem] overflow-auto border-t p-3 lg:max-h-[32rem]">
      <slot />
    </div>
  </section>
</template>
