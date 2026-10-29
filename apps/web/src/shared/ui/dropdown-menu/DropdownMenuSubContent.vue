<script setup lang="ts">
import type { DropdownMenuSubContentEmits, DropdownMenuSubContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DropdownMenuPortal,
  DropdownMenuSubContent,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/shared/utils/cn"

defineOptions({
  inheritAttrs: false,
})

/*
 * Portalled like the root content (#441). Rendered inside the root, a submenu
 * was positioned against a parent that is itself mid-zoom while it animates
 * and that scrolls (`overflow-y-auto`), so it could open clipped or offset.
 * The collision padding keeps a flipped submenu off the viewport edge.
 */
const props = withDefaults(
  defineProps<DropdownMenuSubContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    collisionPadding: 8,
  },
)
const emits = defineEmits<DropdownMenuSubContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DropdownMenuPortal>
    <DropdownMenuSubContent
      data-slot="dropdown-menu-sub-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn('bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--reka-dropdown-menu-content-available-height) min-w-[8rem] max-w-(--reka-dropdown-menu-content-available-width) origin-(--reka-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-lg', props.class)"
    >
      <slot />
    </DropdownMenuSubContent>
  </DropdownMenuPortal>
</template>
