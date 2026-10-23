<script setup lang="ts">
// Mermaid block: renders the diagram, and on demand shows the source beside a
// live preview. Parse errors are reported in place rather than replacing the
// diagram with a red box — losing the last good render while you are mid-edit
// is the thing that makes text-based diagramming feel hostile. The failing
// line is marked in the source's gutter and band, and the status under it says
// either which diagram type parsed or what the parser expected (#476).
import { computed, onMounted, ref, useId, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import DOMPurify from 'dompurify'
import { Check, CircleCheck, CircleX, Code2, Trash2 } from 'lucide-vue-next'
import { useTheme } from '@/lib/theme'
import { mermaidConfig, mermaidProblem, mermaidSvg, type MermaidProblem } from '@/lib/mermaid'
import { diagramAttrs } from '@/lib/diagram-gallery'
import { useDiagramLayout } from './diagram-layout'
import DiagramPlacement from './DiagramPlacement.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps(nodeViewProps)
const editing = ref(false)
const svg = ref('')
const type = ref('')
const problem = ref<MermaidProblem | null>(null)
const draft = ref<string>((props.node.attrs.code as string) ?? '')
const theme = useTheme()
const statusId = useId()
const { wrap, layoutAttrs, resize, place } = useDiagramLayout(props, editing)

/** One gutter number per source line; the textarea is that many rows, so it never scrolls inside the block. */
const lineCount = computed(() => draft.value.split('\n').length)

async function render(code: string) {
  if (!code.trim()) {
    svg.value = ''
    type.value = ''
    problem.value = null
    return
  }
  try {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize(mermaidConfig(theme.isDark.value))
    const out = await mermaidSvg(mermaid, code)
    svg.value = DOMPurify.sanitize(out.svg, { USE_PROFILES: { svg: true, svgFilters: true } })
    type.value = out.type
    problem.value = null
  } catch (e) {
    // Keep the previous SVG on screen; only the message changes.
    problem.value = mermaidProblem(e, code)
  }
}

onMounted(() => void render(draft.value))
// Also the path an edit takes: onInput writes the attribute, this renders it.
watch(() => props.node.attrs.code as string, (code) => {
  draft.value = code
  void render(code)
})
watch(theme.isDark, () => void render(draft.value))

/**
 * Read mode makes a drawn diagram a button that opens the page's lightbox
 * (#476, the host's DiagramLightbox listens for it). Edit mode, or nothing
 * drawn, leaves it alone. A function for the same reason as ImageNode's.
 */
function zoomAttrs() {
  return props.editor.isEditable || !svg.value ? {} : diagramAttrs(t)
}

let timer: ReturnType<typeof setTimeout> | undefined
function onInput() {
  clearTimeout(timer)
  // Debounced: mermaid throws on every half-written line otherwise, and the
  // preview would strobe between error and diagram as you type.
  timer = setTimeout(() => props.updateAttributes({ code: draft.value }), 350)
}
</script>

<template>
  <NodeViewWrapper class="kn-block kn-mermaid" v-bind="layoutAttrs" :data-selected="selected" :data-editing="editing">
    <div class="kn-mermaid-grid" :data-editing="editing">
      <div v-if="editing" class="kn-mermaid-source" contenteditable="false">
        <div class="kn-mermaid-code" :data-error-line="problem?.line || undefined" :style="problem?.line ? { '--kn-error-line': problem.line } : undefined">
          <!-- Spans, not an <ol>: this sits inside the page's prose, whose list styles would number and space it. -->
          <div class="kn-mermaid-lines" aria-hidden="true">
            <span v-for="n in lineCount" :key="n" :data-error="n === problem?.line || undefined">{{ n }}</span>
          </div>
          <textarea
            v-model="draft"
            spellcheck="false"
            wrap="off"
            :rows="Math.max(lineCount + 1, 8)"
            class="kn-mermaid-textarea"
            :aria-label="t('editor.mermaidSource')"
            :aria-invalid="!!problem"
            :aria-describedby="statusId"
            @input="onInput"
          />
        </div>
        <p :id="statusId" class="kn-mermaid-status" :data-state="problem ? 'error' : 'ok'" aria-live="polite">
          <template v-if="problem">
            <CircleX class="size-3.5 shrink-0" aria-hidden="true" />
            <span>{{
              problem.line
                ? t('editor.mermaidErrorAt', { line: problem.line, message: problem.message || t('editor.mermaidInvalid') })
                : problem.message || t('editor.mermaidInvalid')
            }}</span>
          </template>
          <template v-else-if="type">
            <CircleCheck class="size-3.5 shrink-0" aria-hidden="true" />
            <span>{{ t('editor.mermaidValid', { type }) }}</span>
          </template>
        </p>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized mermaid output -->
      <div class="kn-mermaid-preview" v-bind="zoomAttrs()" v-html="svg" @dblclick="editor.isEditable && (editing = true)" />
    </div>

    <template v-if="editor.isEditable && !editing">
      <span class="kn-resize-grip" data-side="left" @pointerdown="resize($event, 'left')" />
      <span class="kn-resize-grip" data-side="right" @pointerdown="resize($event, 'right')" />
    </template>
    <div v-if="editor.isEditable" class="kn-block-actions" contenteditable="false">
      <button v-if="!editing" type="button" @click="editing = true"><Code2 class="size-3.5" /> {{ t('editor.editSource') }}</button>
      <button v-else type="button" @click="editing = false"><Check class="size-3.5" /> {{ t('editor.done') }}</button>
      <DiagramPlacement v-if="!editing" :wrap="wrap" @place="place" />
      <button type="button" :aria-label="t('editor.deleteDiagram')" @click="deleteNode()"><Trash2 class="size-3.5" /></button>
    </div>
  </NodeViewWrapper>
</template>
