<script setup lang="ts">
import type { DialogOverlayProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { DialogOverlay } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<DialogOverlayProps & { class?: HTMLAttributes["class"] }>()
</script>

<template>
  <DialogOverlay
    data-slot="dialog-overlay"
    :class="cn(
      'fixed inset-0 z-50 bg-foreground/25 backdrop-blur-[2px] dark:bg-black/60',
      'data-[state=open]:animate-in data-[state=open]:fade-in-0',
      'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
      props.class,
    )"
  />
</template>
