<script setup lang="ts">
/**
 * One collapsible section of an endpoint card (#78): a real disclosure button
 * (`aria-expanded`, controlling a labelled region) with the section's name and
 * a count, so a closed card still says how much is inside it.
 *
 * Closed, the panel is `hidden="until-found"`, not removed: the browser's
 * find-in-page still reaches a parameter name inside it and opens the section
 * (`beforematch`), so collapsing a card never hides a word from search.
 *
 * `collapsible: false` drops the button and always shows the panel — the
 * editor, where the section is where the author types.
 */
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { ChevronRight } from 'lucide-vue-next'

const props = withDefaults(defineProps<{ label: string; count?: number | null; collapsible?: boolean }>(), {
  count: null,
  collapsible: true,
})
const open = defineModel<boolean>('open', { default: false })
const id = useId()
const panel = ref<HTMLElement | null>(null)

const reveal = () => (open.value = true)
onMounted(() => panel.value?.addEventListener('beforematch', reveal))
onBeforeUnmount(() => panel.value?.removeEventListener('beforematch', reveal))
</script>

<template>
  <div class="kn-api-disclosure" :data-state="open || !props.collapsible ? 'open' : 'closed'">
    <button
      v-if="props.collapsible"
      type="button"
      class="kn-api-disclosure-trigger"
      contenteditable="false"
      :aria-expanded="open"
      :aria-controls="id"
      @click="open = !open"
    >
      <ChevronRight class="kn-api-disclosure-chevron" aria-hidden="true" />
      <span class="min-w-0 truncate">{{ label }}</span>
      <span v-if="count" class="kn-api-count">{{ count }}</span>
    </button>
    <div
      :id="id"
      ref="panel"
      class="kn-api-disclosure-panel"
      role="region"
      :aria-label="label"
      :hidden="props.collapsible && !open ? ('until-found' as unknown as boolean) : undefined"
    >
      <slot />
    </div>
  </div>
</template>
