<script setup lang="ts">
// A settings section: title and explanation on the left, controls on the right.
//
// The one-column form this replaced left ~400px of dead space beside every
// field on a wide screen, and gave the section headings nothing to do but sit
// above the thing they named. Here the description column earns the width and
// the heading anchors the row it belongs to.
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <section class="grid gap-x-10 gap-y-4 border-b py-6 first:pt-0 last:border-b-0 md:grid-cols-[16rem_minmax(0,1fr)]">
    <div class="md:pt-0.5">
      <h2 class="text-sm font-semibold">{{ title }}</h2>
      <p v-if="description" class="text-muted-foreground mt-1 text-xs leading-relaxed">{{ description }}</p>
      <slot name="aside" />
    </div>
    <div class="max-w-xl space-y-4">
      <slot />
    </div>
  </section>
</template>
