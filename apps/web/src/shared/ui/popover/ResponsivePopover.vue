<script setup lang="ts">
/**
 * One floating panel, two surfaces.
 *
 * At `sm` and up it is an anchored popover: Floating UI flips, shifts and sizes
 * it against the viewport, and it is portalled so no scrolling ancestor can
 * crop it. Below `sm` the same content arrives as a bottom sheet, because a
 * 288px panel hung off a 32px button in a four-button toolbar row has nowhere
 * good to go on a 360px screen — it can only be shifted somewhere less wrong.
 *
 * `sm` is the hinge the shell already reflows content at; the rail's own
 * `lg` hinge is a different question (navigation), so it is not reused here.
 *
 * SSR: the server cannot see the viewport, so it renders the popover branch.
 * A bare `useMediaQuery` reads the real width during the client's setup, and
 * on a phone the first client render then has a `<Sheet>` where the server
 * wrote a comment — a hydration node mismatch on every page with a bell in the
 * toolbar. `useHydratedMediaQuery` holds the popover branch until mount, so
 * hydration matches and the sheet takes over a tick later, while still closed.
 */
import { ref } from 'vue'
import { useHydratedMediaQuery } from '@/shared/composables/use-hydrated'
import type { HTMLAttributes } from 'vue'
import Popover from './Popover.vue'
import PopoverContent from './PopoverContent.vue'
import PopoverTrigger from './PopoverTrigger.vue'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/shared/ui/sheet'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    /**
     * Names the panel. Shown as the sheet's heading on a phone, and read to
     * screen readers on both surfaces — a bottom sheet with no heading is an
     * unlabelled dialog.
     */
    title: string
    /** Optional one-line explanation under the heading, compact surface only. */
    description?: string
    side?: 'top' | 'right' | 'bottom' | 'left'
    align?: 'start' | 'center' | 'end'
    sideOffset?: number
    /** Applied to the popover box; the sheet sizes itself. */
    panelClass?: HTMLAttributes['class']
  }>(),
  { side: 'top', align: 'start', sideOffset: 8 },
)

const open = defineModel<boolean>('open', { default: false })
const isCompact = useHydratedMediaQuery('(max-width: 639.98px)')
const sheetEl = ref<unknown>(null)

function close() {
  open.value = false
}

function onSheetOpen(event: Event) {
  event.preventDefault()
  const el = (sheetEl.value as { $el?: HTMLElement } | null)?.$el
  el?.focus?.()
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <slot name="trigger" :open="open" />
    </PopoverTrigger>
    <PopoverContent
      v-if="!isCompact"
      :side="side"
      :align="align"
      :side-offset="sideOffset"
      :class="props.panelClass"
      :aria-label="title"
    >
      <slot :compact="false" :close="close" />
    </PopoverContent>
  </Popover>

  <!-- Compact: the panel becomes a thumb-reachable sheet. Padded past the home
       indicator so the last row of a list is never under it. -->
  <Sheet v-if="isCompact" v-model:open="open">
    <!-- Focus enters the sheet, but not the first field: a search input would
         raise the keyboard over the list before the reader has seen it, and
         the recents at the top are the whole reason the list is ordered the
         way it is. The panel itself takes focus, so Escape and the close
         button are still one key away. -->
    <SheetContent
      ref="sheetEl"
      side="bottom"
      tabindex="-1"
      class="max-h-[85svh] gap-0 rounded-t-xl px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none"
      @open-auto-focus="onSheetOpen"
    >
      <SheetHeader class="gap-1 p-0 pr-8 pb-3 text-left">
        <SheetTitle class="text-base">{{ title }}</SheetTitle>
        <p v-if="description" class="text-muted-foreground text-xs">{{ description }}</p>
      </SheetHeader>
      <div class="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <slot :compact="true" :close="close" />
      </div>
    </SheetContent>
  </Sheet>
</template>
