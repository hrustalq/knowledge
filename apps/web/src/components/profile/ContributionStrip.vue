<script setup lang="ts">
/**
 * What the year was made of — one bar split by kind, and a filter.
 *
 * It is a breakdown, not a chart: no ring, no legend floating beside a donut,
 * no library. Each segment is proportional, each is a button, and picking one
 * narrows the list below. Deselecting is picking it again.
 *
 * A kind with no entries is dropped rather than drawn at zero width: a
 * segment too small to hit is a control that lies about being one.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ActivityKind } from '@knowledge/contracts'
import { ACTIVITY_KIND_STYLES } from '@/lib/activity-kinds'

const props = defineProps<{
  byKind: Record<ActivityKind, number>
  total: number
  active: ActivityKind | null
}>()
const emit = defineEmits<{ 'update:active': [ActivityKind | null] }>()

const { t } = useI18n()

const segments = computed(() =>
  ACTIVITY_KIND_STYLES.map((style) => ({
    ...style,
    n: props.byKind[style.kind] ?? 0,
    share: props.total > 0 ? (props.byKind[style.kind] ?? 0) / props.total : 0,
  })).filter((s) => s.n > 0),
)

function toggle(kind: ActivityKind) {
  emit('update:active', props.active === kind ? null : kind)
}
</script>

<template>
  <div v-if="segments.length" :data-kn-strip-filtered="active !== null">
    <div class="flex gap-1" role="group" :aria-label="t('profile.strip.label')">
      <button
        v-for="s in segments"
        :key="s.kind"
        type="button"
        class="kn-strip-seg"
        :class="active === s.kind ? 'kn-strip-seg--on' : ''"
        :style="{ '--kn-seg': s.color, flexGrow: s.share, flexBasis: 0 }"
        :aria-pressed="active === s.kind"
        :aria-label="t('profile.strip.filter', { kind: t(s.labelKey), n: s.n })"
        @click="toggle(s.kind)"
      />
    </div>
    <ul class="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
      <li v-for="s in segments" :key="s.kind">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-sm text-xs transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          :class="active !== null && active !== s.kind ? 'opacity-45' : ''"
          :aria-pressed="active === s.kind"
          @click="toggle(s.kind)"
        >
          <span class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: s.color }" />
          <span :class="active === s.kind ? 'font-medium' : 'text-muted-foreground'">{{ t(s.labelKey) }}</span>
          <span class="font-medium tabular-nums">{{ s.n }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
