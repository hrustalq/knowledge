<script setup lang="ts">
// Empty state for the Skills and Plugins tabs.
//
// Both started as one muted sentence centred in ~500px of nothing, which told
// an admin that the list was empty — the one thing the blank list already
// said. This sits directly under the toolbar, explains what the thing is for,
// shows a concrete example of one, and carries the action.
import type { Component } from 'vue'

defineProps<{
  icon: Component
  title: string
  body: string
  /** A worked example, so "what would I even put here" has an answer. */
  example?: { label: string; lines: string[] }
}>()
</script>

<template>
  <div class="rounded-lg border border-dashed px-6 py-10">
    <div class="mx-auto max-w-md text-center">
      <component :is="icon" class="text-muted-foreground/50 mx-auto size-6" />
      <h3 class="mt-3 text-sm font-medium">{{ title }}</h3>
      <p class="text-muted-foreground mx-auto mt-1.5 text-sm leading-relaxed">{{ body }}</p>

      <div v-if="example" class="bg-muted/50 mt-5 rounded-md p-3 text-left">
        <p class="text-muted-foreground text-[0.6875rem] font-medium tracking-wide uppercase">
          {{ example.label }}
        </p>
        <ul class="mt-1.5 space-y-0.5">
          <li v-for="line in example.lines" :key="line" class="text-muted-foreground font-mono text-xs">
            {{ line }}
          </li>
        </ul>
      </div>

      <div class="mt-5 flex justify-center">
        <slot name="action" />
      </div>
    </div>
  </div>
</template>
