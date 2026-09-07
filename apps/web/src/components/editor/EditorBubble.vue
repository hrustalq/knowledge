<script setup lang="ts">
/**
 * Selection toolbar. Hand-rolled rather than pulling Tiptap's BubbleMenu
 * package: it is ~40 lines of coordinate math, and owning it means the bar can
 * suppress itself inside blocks where inline formatting is meaningless (code,
 * diagrams, whiteboards) instead of hovering uselessly over them.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Editor } from '@tiptap/core'
import { Bold, Code, Highlighter, Italic, Link2, Strikethrough, Underline as UnderlineIcon } from 'lucide-vue-next'
import { STATUS_COLORS, type StatusColor } from '@/lib/markdown/nodes'

const props = defineProps<{ editor: Editor }>()
const emit = defineEmits<{ link: [] }>()

const position = ref<{ top: number; left: number } | null>(null)

const SUPPRESS_IN = ['codeBlock', 'knMermaid', 'knDrawing', 'knFile', 'knToc']

function update() {
  const editor = props.editor
  const { state, view } = editor
  const { from, to, empty } = state.selection
  if (empty || !view.hasFocus() || SUPPRESS_IN.some((name) => editor.isActive(name))) {
    position.value = null
    return
  }
  const start = view.coordsAtPos(from)
  const end = view.coordsAtPos(to, -1)
  position.value = {
    top: Math.min(start.top, end.top) - 8,
    left: (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2,
  }
}



onMounted(() => {
  props.editor.on('selectionUpdate', update)
  props.editor.on('transaction', update)
  props.editor.on('blur', () => {
    // Delay: clicking a button in the bar blurs the editor first, and hiding
    // synchronously would swallow the click.
    setTimeout(() => {
      if (!props.editor.view.hasFocus()) position.value = null
    }, 120)
  })
})

onBeforeUnmount(() => {
  props.editor.off('selectionUpdate', update)
  props.editor.off('transaction', update)
})

const style = computed(() =>
  position.value
    ? { top: `${position.value.top}px`, left: `${position.value.left}px` }
    : { display: 'none' },
)
</script>

<template>
  <div class="kn-bubble" :style="style" role="toolbar" aria-label="Selection formatting">
    <button type="button" :aria-pressed="editor.isActive('bold')" title="Bold" @mousedown.prevent="editor.chain().focus().toggleBold().run()">
      <Bold class="size-4" />
    </button>
    <button type="button" :aria-pressed="editor.isActive('italic')" title="Italic" @mousedown.prevent="editor.chain().focus().toggleItalic().run()">
      <Italic class="size-4" />
    </button>
    <button type="button" :aria-pressed="editor.isActive('underline')" title="Underline" @mousedown.prevent="editor.chain().focus().toggleUnderline().run()">
      <UnderlineIcon class="size-4" />
    </button>
    <button type="button" :aria-pressed="editor.isActive('strike')" title="Strikethrough" @mousedown.prevent="editor.chain().focus().toggleStrike().run()">
      <Strikethrough class="size-4" />
    </button>
    <button type="button" :aria-pressed="editor.isActive('code')" title="Inline code" @mousedown.prevent="editor.chain().focus().toggleCode().run()">
      <Code class="size-4" />
    </button>
    <span class="kn-bubble-sep" />
    <button type="button" :aria-pressed="editor.isActive('highlight')" title="Highlight" @mousedown.prevent="editor.chain().focus().toggleHighlight().run()">
      <Highlighter class="size-4" />
    </button>
    <button type="button" :aria-pressed="editor.isActive('link')" title="Link" @mousedown.prevent="emit('link')">
      <Link2 class="size-4" />
    </button>
    <span class="kn-bubble-sep" />
    <button
      v-for="color in STATUS_COLORS"
      :key="color"
      type="button"
      class="kn-bubble-status"
      :data-kn-status="color"
      :title="`Status: ${color}`"
      :aria-label="`Status ${color}`"
      @mousedown.prevent="editor.chain().focus().toggleStatus(color as StatusColor).run()"
    />
  </div>
</template>
