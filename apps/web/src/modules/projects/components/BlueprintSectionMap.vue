<script setup lang="ts">
/**
 * A blueprint's top-level sections as a map (#716): the Start preview on a wide
 * screen. Each section is a column headed by its title and the note on what
 * belongs there, with the pages beneath it. The columns fill whatever width the
 * pane has, so a wide screen shows the whole project at once instead of a list
 * down its left edge.
 */
import { useI18n } from 'vue-i18n'
import { Layers } from 'lucide-vue-next'
import { blueprintText, type BlueprintNode, type Locale } from '@knowledge/contracts'
import BlueprintTreePreview from '@/modules/projects/components/BlueprintTreePreview.vue'

defineProps<{ tree: BlueprintNode[]; locale: Locale }>()

const { t } = useI18n()
</script>

<template>
  <ol class="kn-section-map">
    <li v-for="(node, i) in tree" :key="i" class="min-w-0 border-t pt-3">
      <p class="flex min-w-0 items-baseline gap-2">
        <span class="min-w-0 text-sm font-medium wrap-break-word">{{ blueprintText(node.title, locale) }}</span>
        <span
          v-if="node.collection"
          class="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-caption"
          :title="t('scaffold.shape.collectionChip')"
        >
          <Layers class="size-3" aria-hidden="true" />
          {{ t('scaffold.shape.collection') }}
        </span>
      </p>
      <p v-if="blueprintText(node.guidance, locale)" class="text-muted-foreground mt-1 line-clamp-3 text-ui leading-snug">
        {{ blueprintText(node.guidance, locale) }}
      </p>
      <BlueprintTreePreview v-if="node.children?.length" class="mt-2" :tree="node.children" :parent="node" :locale="locale" :max="6" nested />
    </li>
  </ol>
</template>

<style scoped>
.kn-section-map {
  display: grid;
  /* `min(100%, …)`: one column, never an overflow, in a pane narrower than a track. */
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
  column-gap: 1.5rem;
  row-gap: 1.25rem;
}
</style>
