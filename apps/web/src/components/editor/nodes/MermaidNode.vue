<script setup lang="ts">
// Mermaid block: renders the diagram, and on demand shows the source beside a
// live preview. Parse errors are reported in place rather than replacing the
// diagram with a red box — losing the last good render while you are mid-edit
// is the thing that makes text-based diagramming feel hostile.
import { onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import DOMPurify from 'dompurify'
import { Check, Code2, Trash2 } from 'lucide-vue-next'
import { useTheme } from '@/lib/theme'

const props = defineProps(nodeViewProps)
const editing = ref(false)
const svg = ref('')
const error = ref<string | null>(null)
const draft = ref<string>((props.node.attrs.code as string) ?? '')
const theme = useTheme()

let seq = 0

async function render(code: string) {
  if (!code.trim()) {
    svg.value = ''
    error.value = null
    return
  }
  try {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme.isDark.value ? 'dark' : 'default',
      fontFamily: 'inherit',
    })
    seq += 1
    const { svg: out } = await mermaid.render(`kn-mmd-${Date.now()}-${seq}`, code)
    svg.value = DOMPurify.sanitize(out, { USE_PROFILES: { svg: true, svgFilters: true } })
    error.value = null
  } catch (e) {
    // Keep the previous SVG on screen; only the message changes.
    error.value = (e as Error).message.split('\n')[0] || 'Diagram could not be parsed'
  }
}

onMounted(() => void render(draft.value))
watch(() => props.node.attrs.code as string, (code) => {
  draft.value = code
  void render(code)
})
watch(theme.isDark, () => void render(draft.value))

let timer: ReturnType<typeof setTimeout> | undefined
function onInput() {
  clearTimeout(timer)
  // Debounced: mermaid throws on every half-written line otherwise, and the
  // preview would strobe between error and diagram as you type.
  timer = setTimeout(() => {
    props.updateAttributes({ code: draft.value })
    void render(draft.value)
  }, 350)
}
</script>

<template>
  <NodeViewWrapper class="kn-block kn-mermaid" :data-selected="selected" :data-editing="editing">
    <div class="kn-mermaid-grid" :data-editing="editing">
      <div v-if="editing" class="kn-mermaid-source" contenteditable="false">
        <textarea
          v-model="draft"
          spellcheck="false"
          class="kn-mermaid-textarea"
          aria-label="Mermaid diagram source"
          @input="onInput"
        />
        <p v-if="error" class="kn-mermaid-error">{{ error }}</p>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized mermaid output -->
      <div class="kn-mermaid-preview" v-html="svg" @dblclick="editor.isEditable && (editing = true)" />
    </div>

    <div v-if="editor.isEditable" class="kn-block-actions" contenteditable="false">
      <button v-if="!editing" type="button" @click="editing = true"><Code2 class="size-3.5" /> Edit source</button>
      <button v-else type="button" @click="editing = false"><Check class="size-3.5" /> Done</button>
      <button type="button" aria-label="Delete diagram" @click="deleteNode()"><Trash2 class="size-3.5" /></button>
    </div>
  </NodeViewWrapper>
</template>
