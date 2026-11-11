<script setup lang="ts" generic="T extends AcceptableValue = AcceptableValue">
import type { AcceptableValue, SelectRootEmits, SelectRootProps } from "reka-ui"
import { SelectRoot, useForwardPropsEmits } from "reka-ui"

// Generic over the option type (upstream shadcn-vue hard-codes AcceptableValue)
// so `v-model` against a narrow ref — a string union like SearchMode, or the
// numeric depth/limit refs — type-checks without a cast at every call site.
const props = defineProps<SelectRootProps<T>>()
const emits = defineEmits<SelectRootEmits<T>>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <SelectRoot
    v-slot="slotProps"
    data-slot="select"
    v-bind="forwarded as SelectRootProps"
  >
    <slot v-bind="slotProps" />
  </SelectRoot>
</template>
