<script setup lang="ts">
/**
 * The floating list behind both `/` (insert a block) and `@` (link a page).
 * One component so the two menus cannot diverge in keyboard behaviour — the
 * thing people notice immediately and can never articulate.
 */
import { computed, nextTick, ref, watch } from 'vue'

export interface CommandItem {
  id: string
  label: string
  hint?: string
  group: string
  icon?: unknown
  keywords?: string
}

const props = defineProps<{
  items: CommandItem[]
  rect: { top: number; bottom: number; left: number } | null
  emptyLabel?: string
}>()
const emit = defineEmits<{ pick: [CommandItem] }>()

const index = ref(0)
const listEl = ref<HTMLElement | null>(null)

const groups = computed(() => {
  const out: { name: string; items: CommandItem[] }[] = []
  for (const item of props.items) {
    const last = out[out.length - 1]
    if (last && last.name === item.group) last.items.push(item)
    else out.push({ name: item.group, items: [item] })
  }
  return out
})

watch(
  () => props.items,
  () => {
    index.value = 0
  },
)

/**
 * Flip above the caret when the menu would run past the viewport. Measured
 * against the real menu height rather than a guess, so a short filtered list
 * does not flip when it still fits.
 */
const position = computed(() => {
  if (!props.rect) return { display: 'none' }
  const height = Math.min(360, 44 + props.items.length * 34)
  const below = typeof window !== 'undefined' ? window.innerHeight - props.rect.bottom : 400
  const flip = below < height + 16
  return {
    left: `${props.rect.left}px`,
    top: flip ? 'auto' : `${props.rect.bottom + 6}px`,
    bottom: flip && typeof window !== 'undefined' ? `${window.innerHeight - props.rect.top + 6}px` : 'auto',
  }
})

function move(delta: number) {
  if (props.items.length === 0) return
  index.value = (index.value + delta + props.items.length) % props.items.length
  void nextTick(() => {
    listEl.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  })
}

function choose(item?: CommandItem) {
  const picked = item ?? props.items[index.value]
  if (picked) emit('pick', picked)
}

/** Called by the parent from the suggestion plugin's keydown hook. */
function onKeyDown(event: KeyboardEvent): boolean {
  if (event.key === 'ArrowDown') {
    move(1)
    return true
  }
  if (event.key === 'ArrowUp') {
    move(-1)
    return true
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    if (props.items.length === 0) return false
    choose()
    return true
  }
  return false
}

defineExpose({ onKeyDown })
</script>

<template>
  <div class="kn-cmd" :style="position" role="listbox" aria-label="Insert">
    <div ref="listEl" class="kn-cmd-scroll quiet-scroll">
      <template v-for="group in groups" :key="group.name">
        <div class="kn-cmd-group">{{ group.name }}</div>
        <button
          v-for="item in group.items"
          :key="item.id"
          type="button"
          role="option"
          class="kn-cmd-item"
          :data-active="items.indexOf(item) === index"
          :aria-selected="items.indexOf(item) === index"
          @mouseenter="index = items.indexOf(item)"
          @mousedown.prevent="choose(item)"
        >
          <span class="kn-cmd-icon"><component :is="item.icon" v-if="item.icon" class="size-4" /></span>
          <span class="kn-cmd-label">{{ item.label }}</span>
          <span v-if="item.hint" class="kn-cmd-hint">{{ item.hint }}</span>
        </button>
      </template>
      <p v-if="items.length === 0" class="kn-cmd-empty">{{ emptyLabel ?? 'No matches' }}</p>
    </div>
  </div>
</template>
