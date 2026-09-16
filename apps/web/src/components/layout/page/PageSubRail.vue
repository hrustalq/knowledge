<script setup lang="ts">
/**
 * The flush navigation column: settings sections, the project roster, the docs
 * index, saved merge-request filters.
 *
 * Five pages hand-rolled this shape — a `-mx-4 -my-6 lg:-mx-8` bleed out of the
 * content padding, then `lg:h-[calc(100vh-5.75rem)]` to make the column stick.
 * That number is the topbar plus the breadcrumb strip, written out by hand in
 * four files and one stylesheet rule, and the breadcrumb strip is conditional
 * (`v-if="crumbs.length > 0"`). Every page that used it happened to have a
 * trail, so nothing was visibly broken — but the next sub-rail on a route
 * without one would have been 36px taller than the viewport, and nothing in the
 * code said so. The height now comes from `--kn-chrome-h`, which the shell
 * publishes from the chrome it actually rendered.
 *
 * One element, two collapses, which is why this is a component and not two:
 * beside the content at `lg` it closes by width; stacked above it below that, it
 * closes by height, because nothing here can know how tall a list of saved
 * filters is. A second instance would be a second copy of the rail's state —
 * a name half-typed in one and empty in the other, at whichever width the
 * reader happened to resize past.
 *
 * `bg-sidebar` rather than the page ground, always. A sub-rail is chrome, and
 * the tone is what says so before you have read a word of it; the settings nav
 * used to be page-toned and read as content that happened to be narrow.
 */
withDefaults(
  defineProps<{
    /** aria-label for the landmark — this is a `<nav>`, so it needs a name. */
    label: string
    open?: boolean
    /**
     * A rail that is simply there (settings sections) rather than one you reach
     * for (saved filters). Permanent rails ignore `open` entirely, so a page
     * cannot half-implement collapsing and leave the reader without a way back.
     */
    permanent?: boolean
    /** Column width at `lg`. The saved-filter rail is 14rem, rosters want 16. */
    width?: string
  }>(),
  { open: true, permanent: false, width: '14rem' },
)
</script>

<template>
  <div class="kn-subrail" :data-open="permanent || open" :style="{ '--kn-subrail-w': width }">
    <nav :aria-label="label" class="kn-subrail-inner bg-sidebar">
      <slot />
    </nav>
  </div>
</template>
