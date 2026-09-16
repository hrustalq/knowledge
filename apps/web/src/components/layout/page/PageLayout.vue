<script setup lang="ts">
/**
 * The page layer's one wrapper.
 *
 * `App.vue` owns the shell — the rail, the topbar, the breadcrumb strip and the
 * scrolling `<main>` — and that part was already good. Everything *inside*
 * `<main>` was not: thirty-odd pages each rebuilt the same four or five
 * decisions, slightly differently, and a reader crossing them had to re-find
 * the title, the actions and the state on every route.
 *
 * So this owns exactly the decisions that are the same on every page — the
 * measure, where the head sits, where a sub-rail sits, where a detail rail
 * sits, and which of the two scroll contracts applies — and nothing about what
 * a given page contains.
 *
 * **The two scroll contracts.** A `canvas` page owns the viewport and scrolls
 * something inside itself; every other variant grows with its content and lets
 * `<main>` do the scrolling. That distinction already existed as `meta.fill` on
 * the route, and the route's fact and the page's markup had to agree with
 * nothing checking — so a mismatch is now a dev-time warning rather than a page
 * that silently scrolls twice.
 *
 * **The bleed.** A sub-rail has to sit flush against the shell rather than
 * float inside the page's padding, which means cancelling that padding with
 * negative margins. Five pages wrote `-mx-4 -my-6 lg:-mx-8` by hand. It is one
 * decision, so it is made once, here.
 *
 * The detail grid keeps the incumbent `lg`/`xl` steps rather than inventing new
 * ones — DESIGN.md's rule is against reaching for extra breakpoints in new
 * layout work, and these are the two the document page already shipped. What
 * did go is the `2xl:` step, which only one of the two pages had: the rail was
 * 32rem on a document and 28rem on a project at the same width, for no reason
 * either page could state.
 */
import { computed, useSlots, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import PageHeader from './PageHeader.vue'
import { PAGE_MEASURE, isCanvas, type PageVariant } from './page-chrome'

const props = withDefaults(
  defineProps<{
    variant?: PageVariant
    title?: string
    subtitle?: string
    /** Chrome-strip sizing for a canvas route's head. See PageHeader. */
    dense?: boolean
    /**
     * Opt out of the variant's measure.
     *
     * For a shell that hosts child routes rather than content of its own — the
     * settings surface is the only one today. Capping there would cap its
     * children too, and they are the ones that know whether they are a form or
     * a table.
     */
    measure?: boolean
  }>(),
  { variant: 'list', title: undefined, subtitle: undefined, dense: false, measure: true },
)

/*
 * Attributes land on the content column, not on the outer bleed. `data-kn-pane`
 * is the reason: the router hands a view-transition name to whichever pane a
 * navigation replaced, and on the settings surface that is the column beside
 * the nav — the nav is the same nav afterwards and must not travel.
 */
defineOptions({ inheritAttrs: false })

const slots = useSlots()
const route = useRoute()

const canvas = computed(() => isCanvas(props.variant))
const hasSubRail = computed(() => !!slots['sub-rail'])
const hasRail = computed(() => !!slots.rail)
const hasHead = computed(
  () => !!props.title || !!slots.title || !!slots.status || !!slots.actions || !!slots.meta,
)

/*
 * `canvas` and `meta.fill` are the same fact stated in two places, and until
 * now nothing held them together: a page that laid itself out as a canvas on a
 * route without `meta.fill` got a column sized from its content, so every
 * `flex-1` inside it resolved against nothing and the page scrolled twice.
 * Dev-only, because in production the answer is to fix the route, not to warn
 * the reader.
 */
if (import.meta.env.DEV) {
  watchEffect(() => {
    if (canvas.value !== !!route.meta.fill) {
      console.warn(
        `[PageLayout] variant="${props.variant}" on ${route.path}, but meta.fill is ` +
          `${String(!!route.meta.fill)}. A canvas page must be declared \`meta.fill\` on its ` +
          `route, and only a canvas page may be.`,
      )
    }
  })
}

const rootClass = computed(() => {
  if (hasSubRail.value) {
    return canvas.value
      ? 'flex h-full min-h-0 flex-col lg:flex-row lg:items-stretch'
      : '-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 lg:flex-row lg:items-stretch'
  }
  return canvas.value
    ? 'flex h-full min-h-0 w-full min-w-0 flex-col'
    : 'flex min-h-0 w-full min-w-0 flex-1 flex-col'
})

const columnClass = computed(() => {
  const parts = ['flex min-h-0 min-w-0 flex-1 flex-col']
  // A canvas lays itself out; anything else gets the standard block rhythm.
  if (!canvas.value) parts.push(hasSubRail.value ? 'gap-4 px-4 py-6 lg:px-8' : 'gap-4')
  /*
   * A cap, where there is one, is centred — the auto margins absorb the free
   * space `max-width` refuses, which is how DESIGN.md already describes prose:
   * capped *and* centred. Only `prose` carries one; every other variant fills
   * its column, because this system spends the width it is given.
   */
  const measure = props.measure ? PAGE_MEASURE[props.variant] : ''
  if (measure) parts.push(measure, 'mx-auto')
  return parts.join(' ')
})

/**
 * The body carries the standard gap so a page can drop sections straight in
 * without restating it. Every list page in the app had already settled on the
 * same `gap-4`; this is that agreement written down once.
 */
const bodyClass = computed(() =>
  canvas.value
    ? 'flex min-h-0 min-w-0 flex-1 flex-col'
    : 'flex min-w-0 flex-1 flex-col gap-4',
)
</script>

<template>
  <div :class="rootClass">
    <slot name="sub-rail" />

    <div v-bind="$attrs" :class="columnClass">
      <!-- A canvas route's head is a bar pinned above a scrolling surface, so it
           takes a rule and its own padding; a document's head is just the first
           thing on the page and takes neither. -->
      <div v-if="hasHead" :class="dense ? 'shrink-0 border-b px-4 py-3 lg:px-6' : ''">
        <PageHeader :title="title" :subtitle="subtitle" :dense="dense">
          <template v-if="slots.title" #title><slot name="title" /></template>
          <template v-if="slots.status" #status><slot name="status" /></template>
          <template v-if="slots.actions" #actions><slot name="actions" /></template>
          <template v-if="slots.meta" #meta><slot name="meta" /></template>
        </PageHeader>
      </div>

      <slot name="tabs" />

      <!-- One subject plus the facts about it. The rail is `lg`-and-up only;
           below that it falls under the content, which is the order you would
           read them in anyway. -->
      <div
        v-if="hasRail"
        class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_28rem] xl:gap-8"
      >
        <div class="min-w-0 space-y-6"><slot /></div>
        <slot name="rail" />
      </div>

      <div v-else :class="bodyClass"><slot /></div>
    </div>
  </div>
</template>
