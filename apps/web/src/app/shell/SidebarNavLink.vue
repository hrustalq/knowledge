<script setup lang="ts">
// One rail destination. While a navigation to it waits on its chunk (#627) the
// icon turns into a spinner and the link reports itself busy.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { Loader2 } from 'lucide-vue-next'
import { isSlowTarget } from '@/app/router/navigation'
import { NAV_CURRENT, NAV_IDLE, type NavItem } from './nav'

const props = defineProps<{ item: NavItem; nested?: boolean }>()
const { t } = useI18n()
const route = useRoute()

const current = computed(() =>
  props.item.to === '/documents' ? route.path === '/documents' : route.path.startsWith(props.item.to),
)
const pending = computed(() => isSlowTarget(props.item.to))
</script>

<template>
  <RouterLink
    :to="item.to"
    class="flex items-center gap-2.5 rounded-md py-1.5 pr-2.5 text-sm transition-colors"
    :class="[
      nested ? 'pl-7' : 'pl-2.5',
      current ? NAV_CURRENT : NAV_IDLE,
    ]"
    :aria-busy="pending || undefined"
  >
    <Loader2 v-if="pending" class="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    <component :is="item.icon" v-else class="size-4 shrink-0" />
    {{ t(item.labelKey) }}
  </RouterLink>
</template>
