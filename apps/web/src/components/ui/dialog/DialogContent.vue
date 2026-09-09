<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { X } from "lucide-vue-next"
import { reactiveOmit } from "@vueuse/core"
import {
  DialogClose,
  DialogContent,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { useI18n } from "vue-i18n"
import { cn } from "@/lib/utils"
import DialogOverlay from "./DialogOverlay.vue"

const { t } = useI18n()

const props = defineProps<
  DialogContentProps & { class?: HTMLAttributes["class"]; hideClose?: boolean }
>()
const emits = defineEmits<DialogContentEmits>()

defineOptions({ inheritAttrs: false })

const delegatedProps = reactiveOmit(props, "class", "hideClose")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent
      data-slot="dialog-content"
      :class="cn(
        'bg-card fixed top-1/2 left-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
        'gap-5 rounded-xl border p-6 shadow-[0_16px_48px_-12px] shadow-foreground/20 dark:shadow-black/60',
        'duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        props.class)"
      v-bind="{ ...$attrs, ...forwarded }"
    >
      <slot />

      <DialogClose
        v-if="!hideClose"
        class="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 absolute top-4 right-4 grid size-7 place-items-center rounded-md transition-colors outline-none focus-visible:ring-3 disabled:pointer-events-none"
      >
        <X class="size-4" />
        <span class="sr-only">{{ t('common.close') }}</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
