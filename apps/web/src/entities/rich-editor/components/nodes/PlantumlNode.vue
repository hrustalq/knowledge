<script setup lang="ts">
// PlantUML block (docs/features/87): renders the diagram, and on demand shows
// the source beside a live preview — the same behaviour as MermaidNode, for the
// same reason: losing the last good drawing while you are mid-edit is what makes
// a text diagram hostile. PlantUML reports a syntax error *inside* an SVG it
// still returns, so the wrapper turns that into an error; the drawing on screen
// stays until a fixed source replaces it.
import { computed, onMounted, ref, useId, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import DOMPurify from 'dompurify'
import { Check, CircleCheck, CircleX, Code2, Trash2 } from 'lucide-vue-next'
import { useTheme } from '@/shared/utils/theme'
import { plantumlProblem, plantumlSvg, type PlantumlProblem } from '@/shared/utils/plantuml'
import { diagramAttrs } from '@knowledge/ui/lightbox'
import { useDiagramLayout } from './diagram-layout'
import DiagramPlacement from './DiagramPlacement.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps(nodeViewProps)
const editing = ref(false)
const svg = ref('')
const problem = ref<PlantumlProblem | null>(null)
const draft = ref<string>((props.node.attrs.code as string) ?? '')
const theme = useTheme()
const statusId = useId()
const { wrap, layoutAttrs, resize, place } = useDiagramLayout(props, editing)

/** One gutter number per source line; the textarea is that many rows, so it never scrolls inside the block. */
const lineCount = computed(() => draft.value.split('\n').length)

async function render(code: string) {
  if (!code.trim()) {
    svg.value = ''
    problem.value = null
    return
  }
  try {
    const out = await plantumlSvg(code, theme.isDark.value)
    svg.value = DOMPurify.sanitize(out, { USE_PROFILES: { svg: true, svgFilters: true } })
    problem.value = null
  } catch (e) {
    // Keep the previous SVG on screen; only the message changes.
    problem.value = plantumlProblem(e)
  }
}

onMounted(() => void render(draft.value))
// Also the path an edit takes: onInput writes the attribute, this renders it.
watch(
  () => props.node.attrs.code as string,
  (code) => {
    draft.value = code
    void render(code)
  },
)
watch(theme.isDark, () => void render(draft.value))

/**
 * Read mode makes a drawn diagram a button that opens the page's lightbox
 * (#476, the host's DiagramLightbox listens for it). Edit mode, or nothing
 * drawn, leaves it alone.
 */
function zoomAttrs() {
  return props.editor.isEditable || !svg.value ? {} : diagramAttrs(t)
}

let timer: ReturnType<typeof setTimeout> | undefined
function onInput() {
  clearTimeout(timer)
  // Debounced: PlantUML parses the whole source on every half-written line, and
  // the preview would strobe between error and diagram as you type.
  timer = setTimeout(() => props.updateAttributes({ code: draft.value }), 350)
}
</script>

<template>
  <!-- The inner classes are the diagram source editor's, shared with MermaidNode:
       one layout and one set of styles for both blocks. -->
  <NodeViewWrapper class="kn-block kn-plantuml" v-bind="layoutAttrs" :data-selected="selected" :data-editing="editing">
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
            :aria-label="t('editor.plantumlSource')"
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
                ? t('editor.plantumlErrorAt', { line: problem.line, message: problem.message || t('editor.plantumlInvalid') })
                : problem.message || t('editor.plantumlInvalid')
            }}</span>
          </template>
          <template v-else-if="svg">
            <CircleCheck class="size-3.5 shrink-0" aria-hidden="true" />
            <span>{{ t('editor.plantumlValid') }}</span>
          </template>
        </p>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized PlantUML output -->
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
