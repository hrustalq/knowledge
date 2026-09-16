<script setup lang="ts">
/**
 * The one page head.
 *
 * Before this there were sixteen: `text-2xl` on most settings pages, `text-lg`
 * on /workflows, `text-xl` on the pages index, `text-base` on a connector run —
 * so a top-level destination rendered smaller than a settings subpage, and the
 * eye had to re-find the title on every route. The row order is fixed for the
 * same reason: identity, then what state it is in, then what you can do to it.
 *
 * Three places to put things, and they are not interchangeable:
 *
 * - `status` sits *inline after the title*, because a badge is part of naming
 *   the thing — "Orders (draft)" is one phrase, not a title and a fact.
 * - `actions` is right-aligned off one auto-margin. It carries the margin
 *   itself rather than the slot before it, so a page whose reader has no write
 *   access still balances instead of leaving a gap where Edit would have been.
 * - `meta` is the full-width line underneath — revision numbers, hashes,
 *   timestamps. Below the row rather than in it, because it is what you check
 *   after you have decided this is the right page, not while deciding.
 *
 * `dense` is for a canvas route's chrome strip (the pages index, the import
 * wizard) rather than a document's head. It is a real second size, not a
 * loophole: a bar pinned above a scrolling surface is a different object from
 * the first line of a page, and sizing them alike made the strip shout.
 */
withDefaults(
  defineProps<{
    title?: string
    subtitle?: string
    dense?: boolean
  }>(),
  { title: undefined, subtitle: undefined, dense: false },
)
</script>

<template>
  <header :class="dense ? 'flex flex-col gap-1.5' : 'space-y-2'">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div class="min-w-0">
        <!-- The slot wins over the prop: a project leads with its avatar and a
             person with their face, and those are still the page's identity. -->
        <slot name="title">
          <h1
            v-if="title"
            :class="
              dense
                ? 'font-display truncate text-xl leading-tight font-bold tracking-tight'
                : 'font-display text-2xl font-bold tracking-tight'
            "
          >
            {{ title }}
          </h1>
        </slot>
        <p
          v-if="subtitle"
          :class="dense ? 'truncate text-xs text-muted-foreground' : 'mt-0.5 text-sm text-muted-foreground'"
        >
          {{ subtitle }}
        </p>
      </div>

      <slot name="status" />

      <!-- Rendered only when something fills it, so an empty actions area
           cannot collapse the row's alignment or leave a stray gap. -->
      <div v-if="$slots.actions" class="ml-auto flex flex-wrap items-center gap-1.5">
        <slot name="actions" />
      </div>
    </div>

    <slot name="meta" />
  </header>
</template>
