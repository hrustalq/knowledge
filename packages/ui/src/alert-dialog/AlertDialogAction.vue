<script setup lang="ts">
import type { AlertDialogActionProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { ButtonVariants } from '../button'
import { reactiveOmit } from "@vueuse/core"
import { AlertDialogAction } from "reka-ui"
import { cn } from "../cn"
import { buttonVariants } from '../button'

// `variant="destructive"` rather than hand-rolled fill classes: the variant is
// what carries the dark-mode fill that keeps white text readable.
const props = defineProps<AlertDialogActionProps & {
  class?: HTMLAttributes["class"]
  variant?: ButtonVariants["variant"]
}>()

const delegatedProps = reactiveOmit(props, "class", "variant")
</script>

<template>
  <AlertDialogAction v-bind="delegatedProps" :class="cn(buttonVariants({ variant }), props.class)">
    <slot />
  </AlertDialogAction>
</template>
