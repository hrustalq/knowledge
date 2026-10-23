<script setup lang="ts">
// Where a diagram sits in the text (#476): floated left or right with the
// paragraphs wrapping beside it, or centred on its own line. Lives in the
// block's action bar beside Edit and Delete.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-vue-next'
import type { DiagramWrap } from '@/lib/markdown/nodes'

defineProps<{ wrap: DiagramWrap | null }>()
const emit = defineEmits<{ place: [wrap: DiagramWrap | null] }>()

const { t } = useI18n()
const options = computed(() => [
  { wrap: 'left' as const, icon: AlignLeft, label: t('editor.diagramWrapLeft') },
  { wrap: null, icon: AlignCenter, label: t('editor.diagramCentre') },
  { wrap: 'right' as const, icon: AlignRight, label: t('editor.diagramWrapRight') },
])
</script>

<template>
  <span class="kn-block-actions-group" role="group" :aria-label="t('editor.diagramPlacement')">
    <button
      v-for="option in options"
      :key="option.wrap ?? 'centre'"
      type="button"
      :aria-pressed="wrap === option.wrap"
      :aria-label="option.label"
      :title="option.label"
      @click="emit('place', option.wrap)"
    >
      <component :is="option.icon" class="size-3.5" />
    </button>
  </span>
</template>
