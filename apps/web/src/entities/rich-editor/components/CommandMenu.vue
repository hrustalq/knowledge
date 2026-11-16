<script setup lang="ts">
/**
 * The floating list behind both `/` (insert a block) and `@` (link a page).
 * One component so the two menus cannot diverge in keyboard behaviour — the
 * thing people notice immediately and can never articulate.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

export interface CommandItem {
  id: string
  label: string
  hint?: string
  group: string
  icon?: unknown
  keywords?: string
  /** What `id` names, for the menus whose entries are not all the same thing. */
  kind?: 'page' | 'person' | 'agent'
}

const { t } = useI18n()

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

/** `.kn-cmd` is 19rem (editor.css); the clamp needs the number, not the CSS. */
const MENU_WIDTH = 304

/**
 * Placed inside the visual viewport, so an open keyboard (#1035) shrinks the
 * room instead of hiding the menu behind it. Flips above the caret only when
 * the space below is short and the space above is larger; the list then takes
 * whatever the chosen side leaves, so a short screen scrolls it.
 */
const placement = computed(() => {
  if (!props.rect || typeof window === 'undefined') return { style: { display: 'none' }, list: {} }
  const vv = window.visualViewport
  const top = vv?.offsetTop ?? 0
  const viewH = vv?.height ?? window.innerHeight
  const viewW = vv?.width ?? window.innerWidth
  const height = Math.min(360, 44 + props.items.length * 34)
  const below = top + viewH - props.rect.bottom - 14
  const above = props.rect.top - top - 14
  const flip = below < height + 16 && above > below
  const room = flip ? above : below
  const left = Math.max(8, Math.min(props.rect.left, viewW - MENU_WIDTH - 8))
  return {
    style: {
      left: `${left}px`,
      top: flip ? 'auto' : `${props.rect.bottom + 6}px`,
      bottom: flip ? `${window.innerHeight - props.rect.top + 6}px` : 'auto',
    },
    list: { maxHeight: `${Math.max(96, room - 12)}px` },
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
  <!--
    `data-kn-editor-ui`: this teleports to `<body>`, so every "pressed outside
    the editor" guard sees a press on it as a press somewhere else and tears
    down the thing being written in — the composer collapsed the instant you
    picked an item. The marker is how those guards recognise editor chrome that
    is no longer an editor descendant. Grep it before removing.
  -->
  <div
    class="kn-cmd"
    data-kn-editor-ui
    :style="placement.style"
    role="listbox"
    :aria-label="t('toolbar.insertMenu')"
  >
    <div ref="listEl" class="kn-cmd-scroll quiet-scroll" :style="placement.list">
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
      <p v-if="items.length === 0" class="kn-cmd-empty">{{ emptyLabel ?? t('editor.noMatches') }}</p>
    </div>
  </div>
</template>
