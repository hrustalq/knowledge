<script setup lang="ts">
/**
 * The Shape step's outline (#716): the blueprint's page tree, drawn flat with
 * its depth as indent, the way the page rail draws a tree.
 *
 * Every move has a button (the toolbar acts on the selected row) and a key, so
 * drag is a shortcut rather than the only way: ↑/↓ select, Alt+↑/↓ reorder,
 * Alt+→/← indent and outdent, Delete removes. A row dropped on another row
 * lands before it, as its sibling; nesting is indent's job.
 */
import { computed, nextTick, ref } from 'vue'
import { animate } from 'motion-v'
import { useI18n } from 'vue-i18n'
import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  GripVertical,
  IndentDecrease,
  IndentIncrease,
  Layers,
  Plus,
  Trash2,
} from 'lucide-vue-next'
import { blueprintText, type BlueprintNode, type Locale } from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { itemTitles, moveNode, removeNode, shiftNode, type NodePath } from '@/modules/projects/model/blueprint-tree'

const props = defineProps<{ tree: BlueprintNode[]; selected: NodePath | null; locale: Locale }>()
const emit = defineEmits<{
  'update:tree': [BlueprintNode[]]
  select: [NodePath | null]
  add: [parent: NodePath | null, index?: number]
}>()

const { t } = useI18n()

interface Row {
  path: NodePath
  key: string
  depth: number
  title: string
  /** The numbered prefix a collection gives this item, shown muted. */
  prefix: string
  pattern: string
  isCollection: boolean
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (nodes: BlueprintNode[], parent: NodePath, parentNode: BlueprintNode | null) => {
    const titles = parentNode?.collection ? itemTitles(parentNode, props.locale) : []
    nodes.forEach((node, i) => {
      const path = [...parent, i]
      const title = blueprintText(node.title, props.locale).trim()
      const full = titles[i] ?? title
      out.push({
        path,
        key: path.join('.'),
        depth: parent.length,
        title,
        prefix: full.endsWith(title) ? full.slice(0, full.length - title.length) : '',
        pattern: blueprintText(node.collection?.childTitlePattern, props.locale).trim(),
        isCollection: !!node.collection,
      })
      walk(node.children ?? [], path, node)
    })
  }
  walk(props.tree, [], null)
  return out
})

const selectedKey = computed(() => props.selected?.join('.') ?? null)

function apply(result: { tree: BlueprintNode[]; path: NodePath } | null) {
  if (!result) return
  emit('update:tree', result.tree)
  emit('select', result.path)
  void focusRow(result.path).then((row) => {
    // The row settles into its new place, so the eye finds where it went.
    // Rows are keyed by path, which a move re-addresses, so this is the one
    // animation a move can make honestly.
    if (row && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      animate(row, { opacity: [0.4, 1], x: [-4, 0] }, { duration: 0.22, ease: [0.32, 0.72, 0, 1] })
    }
  })
}

function shift(dir: 'up' | 'down' | 'in' | 'out') {
  if (props.selected) apply(shiftNode(props.tree, props.selected, dir))
}

function remove() {
  const path = props.selected
  if (!path) return
  const i = rows.value.findIndex((r) => r.key === path.join('.'))
  const next = removeNode(props.tree, path)
  emit('update:tree', next)
  // The row above in reading order: an ancestor or an earlier sibling's
  // subtree, neither re-addressed by the removal, so Delete can repeat.
  const above = i > 0 ? rows.value[i - 1]!.path : next.length ? [0] : null
  emit('select', above)
  if (above) void focusRow(above)
}

function addSibling() {
  if (!props.selected) return emit('add', null)
  const parent = props.selected.slice(0, -1)
  emit('add', parent.length ? parent : null, props.selected[props.selected.length - 1]! + 1)
}

function addChild() {
  if (props.selected) emit('add', props.selected)
}

const list = ref<HTMLElement | null>(null)
async function focusRow(path: NodePath): Promise<HTMLElement | null> {
  await nextTick()
  const row = list.value?.querySelector<HTMLElement>(`[data-path="${path.join('.')}"]`) ?? null
  row?.focus()
  return row
}

function onKey(e: KeyboardEvent, row: Row) {
  const i = rows.value.findIndex((r) => r.key === row.key)
  const moves: Record<string, 'up' | 'down' | 'in' | 'out'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'in', ArrowLeft: 'out' }
  if (e.altKey && moves[e.key]) {
    e.preventDefault()
    return shift(moves[e.key]!)
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const next = rows.value[i + (e.key === 'ArrowDown' ? 1 : -1)]
    if (next) {
      emit('select', next.path)
      void focusRow(next.path)
    }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    remove()
  }
}

/* ---- drag: a shortcut for reordering, never the only path ---- */
const dragging = ref<string | null>(null)
const over = ref<string | null>(null)

function onDrop(target: Row) {
  const from = dragging.value?.split('.').map(Number)
  dragging.value = over.value = null
  if (!from || from.join('.') === target.key) return
  const parent = target.path.slice(0, -1)
  apply(moveNode(props.tree, from, parent.length ? parent : null, target.path[target.path.length - 1]!))
}
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <!-- Acts on the selected row; the keys say the same thing in their titles. -->
    <div class="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2 py-2" role="toolbar" :aria-label="t('scaffold.shape.outline')">
      <Button size="sm" variant="ghost" class="h-7 gap-1 px-2 text-xs" @click="addSibling">
        <Plus class="size-3.5" /> {{ t('scaffold.shape.addPage') }}
      </Button>
      <Button size="sm" variant="ghost" class="h-7 gap-1 px-2 text-xs" :disabled="!selected" @click="addChild">
        <CornerDownRight class="size-3.5" /> {{ t('scaffold.shape.addChild') }}
      </Button>
      <span class="bg-border mx-1 h-4 w-px" aria-hidden="true" />
      <Button size="icon" variant="ghost" class="size-7" :disabled="!selected" :title="t('scaffold.shape.moveUp')" :aria-label="t('scaffold.shape.moveUp')" @click="shift('up')">
        <ArrowUp class="size-3.5" />
      </Button>
      <Button size="icon" variant="ghost" class="size-7" :disabled="!selected" :title="t('scaffold.shape.moveDown')" :aria-label="t('scaffold.shape.moveDown')" @click="shift('down')">
        <ArrowDown class="size-3.5" />
      </Button>
      <Button size="icon" variant="ghost" class="size-7" :disabled="!selected" :title="t('scaffold.shape.indent')" :aria-label="t('scaffold.shape.indent')" @click="shift('in')">
        <IndentIncrease class="size-3.5" />
      </Button>
      <Button size="icon" variant="ghost" class="size-7" :disabled="!selected" :title="t('scaffold.shape.outdent')" :aria-label="t('scaffold.shape.outdent')" @click="shift('out')">
        <IndentDecrease class="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        class="text-muted-foreground hover:text-destructive ml-auto size-7"
        :disabled="!selected"
        :title="t('scaffold.shape.remove')"
        :aria-label="t('scaffold.shape.remove')"
        @click="remove"
      >
        <Trash2 class="size-3.5" />
      </Button>
    </div>

    <div v-if="!rows.length" class="text-muted-foreground px-4 py-8 text-center text-sm">
      <p>{{ t('scaffold.shape.emptyTree') }}</p>
      <Button size="sm" variant="outline" class="mt-3 gap-1" @click="emit('add', null)">
        <Plus class="size-3.5" /> {{ t('scaffold.shape.addPage') }}
      </Button>
    </div>

    <ul v-else ref="list" class="min-h-0 flex-1 overflow-y-auto py-1.5" role="tree" :aria-label="t('scaffold.shape.outline')">
      <li
        v-for="row in rows"
        :key="row.key"
        role="treeitem"
        :aria-level="row.depth + 1"
        :aria-selected="row.key === selectedKey"
        :data-path="row.key"
        :tabindex="row.key === selectedKey || (!selectedKey && row.key === '0') ? 0 : -1"
        draggable="true"
        class="kn-outline-row group"
        :class="[row.key === selectedKey && 'kn-outline-row--selected', over === row.key && dragging !== row.key && 'kn-outline-row--over']"
        :style="{ paddingLeft: `${0.5 + row.depth * 1.1}rem` }"
        @click="emit('select', row.path)"
        @keydown="onKey($event, row)"
        @dragstart="dragging = row.key"
        @dragend="dragging = over = null"
        @dragover.prevent="over = row.key"
        @dragleave="over === row.key && (over = null)"
        @drop.prevent="onDrop(row)"
      >
        <GripVertical class="text-muted-foreground/50 size-3.5 shrink-0 cursor-grab opacity-0 group-hover:opacity-100" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">
          <span v-if="row.prefix" class="text-muted-foreground tabular-nums">{{ row.prefix }}</span>
          <span v-if="row.title">{{ row.title }}</span>
          <span v-else class="text-destructive italic">{{ t('scaffold.shape.untitled') }}</span>
        </span>
        <span
          v-if="row.isCollection"
          class="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-caption"
          :title="t('scaffold.shape.collectionChip')"
        >
          <Layers class="size-3" />
          <span v-if="row.pattern" class="font-mono">{{ row.pattern }}</span>
        </span>
      </li>
    </ul>

    <p class="text-muted-foreground hidden shrink-0 border-t px-3 py-2 text-caption lg:block">{{ t('scaffold.shape.keys') }}</p>
  </div>
</template>

<style scoped>
.kn-outline-row {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0 0.375rem;
  min-height: 2rem;
  padding-right: 0.5rem;
  border-radius: 6px;
  font-size: var(--kn-text-ui, 13px);
  cursor: default;
  outline: none;
  border: 1px solid transparent;
  transition: background-color 120ms ease-out;
}
.kn-outline-row:hover {
  background: color-mix(in oklab, var(--foreground) 4%, transparent);
}
.kn-outline-row--selected,
.kn-outline-row--selected:hover {
  background: color-mix(in oklab, var(--primary) 10%, transparent);
  color: var(--primary);
}
.kn-outline-row:focus-visible {
  border-color: var(--ring);
}
.kn-outline-row--over {
  box-shadow: inset 0 2px 0 var(--primary);
}
@media (prefers-reduced-motion: reduce) {
  .kn-outline-row {
    transition-duration: 0.01ms;
  }
}
</style>
