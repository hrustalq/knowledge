<script setup lang="ts">
/**
 * Floating UI (via reka-ui) does the placement here — flip, shift and size —
 * so nothing in the app has to hand-roll coordinate math again.
 *
 * Three defaults carry the whole "never crops, never overflows" contract:
 *
 * - **Portalled.** The panel renders at the document root, so a scrolling or
 *   `overflow-hidden` ancestor cannot clip it. This is what an `absolute` panel
 *   can never survive.
 * - **`collisionPadding`.** Floating UI keeps the panel this far inside the
 *   viewport on every edge, flipping and shifting as needed, so a trigger near
 *   a screen edge no longer throws its panel off-screen.
 * - **`max-w` / `max-h` from Floating UI's own measurements.** The `size`
 *   middleware publishes the space actually available as CSS variables; binding
 *   the box to them means a long list scrolls inside the panel instead of
 *   growing past the screen.
 */
import type { PopoverContentEmits, PopoverContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  PopoverContent,
  PopoverPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<PopoverContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    sideOffset: 4,
    collisionPadding: 8,
  },
)
const emits = defineEmits<PopoverContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <PopoverPortal>
    <PopoverContent
      data-slot="popover-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn('bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--reka-popover-content-available-height) w-72 max-w-[calc(100vw-1rem)] origin-(--reka-popover-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-2 shadow-md outline-none', props.class)"
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>
