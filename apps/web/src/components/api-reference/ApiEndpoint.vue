<script setup lang="ts">
/**
 * `GET /users/{id}` as one line (#78). The literal path is ink; each `{param}`
 * steps down to the muted ink, so the shape of the route reads before its
 * variables do. Breaks only at a slash, never inside a segment.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { methodTone, pathSegments } from '@/lib/api-spec'
import ApiTone from './ApiTone.vue'

const props = withDefaults(
  defineProps<{ method: string | null; path: string; protocol: 'http' | 'async'; size?: 'lg'; variant?: 'solid' | 'wash' }>(),
  { size: undefined, variant: 'wash' },
)
const { t } = useI18n()
const segments = computed(() => pathSegments(props.path))
</script>

<template>
  <span class="flex min-w-0 items-baseline gap-2.5">
    <ApiTone :tone="methodTone(method)" :variant="variant" class="self-center">{{ method ?? t('apiRef.channel') }}</ApiTone>
    <code class="min-w-0 font-mono [overflow-wrap:anywhere]" :class="size === 'lg' ? 'text-[1rem] font-semibold' : 'text-[0.82rem]'">
      <template v-for="(s, i) in segments" :key="i">
        <span v-if="s.param" class="text-muted-foreground">{{ s.text }}</span>
        <template v-else>{{ s.text }}</template>
      </template>
    </code>
  </span>
</template>
