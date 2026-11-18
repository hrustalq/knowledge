<script setup lang="ts">
// A ```structurizr code block (#1244): a C4 model in two tabs, the drawing
// and its source. The source tab is this code block itself — what the
// markdown stores, highlighted and edited like any other — so it always stays
// in the DOM. A read-only page opens on the drawing; so does an editor, unless
// the source does not parse yet.
//
// Full screen is the editor's (C4StudioHost), not this view's: the button
// only names this block in the URL (`?c4=<n>&view=<v>`, n counting the page's
// C4 blocks), so Back closes it and a link opens it.
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { C4_LANG, parseStructurizr } from '@/core/markdown/structurizr'
import { C4Diagram } from '@/entities/document'

const props = defineProps(nodeViewProps)
const route = useRoute()
const router = useRouter()

const source = computed(() => props.node.textContent)
const parses = (text: string) => {
  try {
    parseStructurizr(text)
    return true
  } catch {
    return false
  }
}
const tab = ref<'diagram' | 'source'>(props.editor.isEditable && !parses(source.value) ? 'source' : 'diagram')

/** This block's place among the page's C4 blocks: its name in the URL. */
function blockIndex(): number {
  const pos = props.getPos()
  let seen = 0
  let mine = -1
  props.editor.state.doc.descendants((node, at) => {
    if (mine >= 0) return false
    if (node.type.name === 'codeBlock' && node.attrs.language === C4_LANG) {
      if (at === pos) mine = seen
      seen++
    }
    return true
  })
  return mine
}

function open(view: number) {
  void router.push({ query: { ...route.query, c4: String(blockIndex()), view: String(view) } })
}
</script>

<template>
  <NodeViewWrapper class="kn-c4-code">
    <C4Diagram v-model:tab="tab" :source="source" :editable="editor.isEditable" :hosts-studio="false" @open="open">
      <template #source>
        <pre><NodeViewContent as="code" class="language-structurizr" /></pre>
      </template>
    </C4Diagram>
  </NodeViewWrapper>
</template>
