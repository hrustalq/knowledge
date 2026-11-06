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
  <!-- The control column takes whatever the page is given; it used to stop at
       36rem, which on a wide screen left the right half of every section
       empty. Field groups inside add columns as it grows rather than
       stretching one input across it.

       Columns follow the section's own width, not the viewport's: settings sit
       beside two rails, so a viewport breakpoint split ~575px into a 16rem
       heading and a ~200px strip of controls on an ordinary laptop. -->
  <section class="@container border-b py-6 first:pt-0 last:border-b-0">
    <div class="grid gap-x-10 gap-y-4 @3xl:grid-cols-[16rem_minmax(0,1fr)] @5xl:grid-cols-[20rem_minmax(0,1fr)]">
      <div class="@3xl:pt-0.5">
        <h2 class="text-sm font-semibold">{{ title }}</h2>
        <p v-if="description" class="text-muted-foreground mt-1 max-w-prose text-xs leading-relaxed">{{ description }}</p>
        <slot name="aside" />
      </div>
      <div class="min-w-0 space-y-4">
        <slot />
      </div>
    </div>
  </section>
</template>
