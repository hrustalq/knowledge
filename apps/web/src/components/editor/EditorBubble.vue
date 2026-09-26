<script setup lang="ts">
/**
 * Selection toolbar. Hand-rolled rather than pulling Tiptap's BubbleMenu
 * package: it is ~40 lines of coordinate math, and owning it means the bar can
 * suppress itself inside blocks where inline formatting is meaningless (code,
 * diagrams, whiteboards) instead of hovering uselessly over them.
 */
import { ref } from 'vue'
import { delay, filter } from 'rxjs'
import { useI18n } from 'vue-i18n'
import type { Editor } from '@tiptap/core'
import { Bold, Code, Highlighter, Italic, Link2, Strikethrough, Underline as UnderlineIcon } from 'lucide-vue-next'
import { STATUS_COLORS, type StatusColor } from '@/lib/markdown/nodes'
import { useAnchoredFloating, type AnchorRect } from '@/lib/use-anchored'
import { useObservable, useSubscription } from '@/lib/rx-vue'
import { editorStreams, readFormatState } from './editor-streams'

const { t } = useI18n()
const props = defineProps<{ editor: Editor }>()
const emit = defineEmits<{ link: [] }>()

/** The selection's own box, in viewport coordinates; Floating UI hangs the bar off it. */
const rect = ref<AnchorRect | null>(null)
const { setFloating, floatingStyles } = useAnchoredFloating(rect, { placement: 'top' })

const SUPPRESS_IN = ['codeBlock', 'knMermaid', 'knDrawing', 'knFile', 'knToc']

const streams = editorStreams(props.editor)
/** Pressed states, from the shared per-frame stream — see `EditorToolbar`. */
const format = useObservable(streams.format$, readFormatState(props.editor))

/**
 * Measured once per frame, not once per transaction: `coordsAtPos` forces a
 * layout, and a held-down key produces transactions faster than the screen
 * shows them.
 */
function update() {
  const editor = props.editor
  const { state, view } = editor
  const { from, to, empty } = state.selection
  if (empty || !view.hasFocus() || SUPPRESS_IN.some((name) => editor.isActive(name))) {
    rect.value = null
    return
  }
  const start = view.coordsAtPos(from)
  const end = view.coordsAtPos(to, -1)
  // Just the box: centring, the gap above it and staying on screen near the
  // viewport edges are Floating UI's job now.
  const left = Math.min(start.left, end.left)
  const top = Math.min(start.top, end.top)
  rect.value = {
    top,
    left,
    width: Math.max(start.right, end.right) - left,
    height: Math.max(start.bottom, end.bottom) - top,
  }
}

useSubscription(streams.frame$.subscribe(update))
// Delayed: clicking a button in the bar blurs the editor first, and hiding
// synchronously would swallow the click. The box can be gone by then — an edit
// composer collapses on save, which blurs and unmounts in the same tick — and
// reading `view` off a destroyed editor throws; unsubscribing on unmount drops
// the pending check with it, where the old bare listener was never removed.
useSubscription(
  streams.blur$
    .pipe(
      delay(120),
      filter(() => props.editor.isDestroyed || !props.editor.view.hasFocus()),
    )
    .subscribe(() => (rect.value = null)),
)
</script>

<template>
  <div v-if="rect" :ref="setFloating" class="kn-bubble" :style="floatingStyles" role="toolbar" :aria-label="t('toolbar.bubble.label')">
    <button type="button" :aria-pressed="format.bold" :title="t('toolbar.bubble.bold')" @mousedown.prevent="editor.chain().focus().toggleBold().run()">
      <Bold class="size-4" />
    </button>
    <button type="button" :aria-pressed="format.italic" :title="t('toolbar.bubble.italic')" @mousedown.prevent="editor.chain().focus().toggleItalic().run()">
      <Italic class="size-4" />
    </button>
    <button type="button" :aria-pressed="format.underline" :title="t('toolbar.bubble.underline')" @mousedown.prevent="editor.chain().focus().toggleUnderline().run()">
      <UnderlineIcon class="size-4" />
    </button>
    <button type="button" :aria-pressed="format.strike" :title="t('toolbar.bubble.strikethrough')" @mousedown.prevent="editor.chain().focus().toggleStrike().run()">
      <Strikethrough class="size-4" />
    </button>
    <button type="button" :aria-pressed="format.code" :title="t('toolbar.bubble.inlineCode')" @mousedown.prevent="editor.chain().focus().toggleCode().run()">
      <Code class="size-4" />
    </button>
    <span class="kn-bubble-sep" />
    <button type="button" :aria-pressed="format.highlight" :title="t('toolbar.highlight')" @mousedown.prevent="editor.chain().focus().toggleHighlight().run()">
      <Highlighter class="size-4" />
    </button>
    <button type="button" :aria-pressed="format.link" :title="t('toolbar.bubble.link')" @mousedown.prevent="emit('link')">
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
