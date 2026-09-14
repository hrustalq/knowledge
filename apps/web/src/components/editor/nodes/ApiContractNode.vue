<script setup lang="ts">
// One documented HTTP endpoint. The header is the only structured part; the
// body below it is ordinary editable content (NodeViewContent), so tables,
// prose and panels all work inside a contract — and so every description still
// reaches the chunker when this serializes to markdown.
import { useI18n } from 'vue-i18n'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { HTTP_METHODS, type HttpMethod } from '@/lib/markdown/nodes'

const { t } = useI18n()
const props = defineProps(nodeViewProps)

// The path is a contenteditable span rather than an <input>, for the reason
// ExpandNode.vue's summary is: an input inside ProseMirror steals selection and
// breaks undo. The method is a native <select>, which holds no text caret and
// so does not.
function commitPath(event: Event) {
  const raw = (event.target as HTMLElement).textContent?.trim() || '/'
  props.updateAttributes({ path: raw.startsWith('/') ? raw : `/${raw}` })
}

function commitMethod(event: Event) {
  props.updateAttributes({ method: (event.target as HTMLSelectElement).value as HttpMethod })
}
</script>

<template>
  <NodeViewWrapper class="kn-api" :data-kn-api="node.attrs.method">
    <!-- An <h3>, not a <div>: the read view and the editor both build the page
         outline from h1–h3, so this is what puts the endpoint in the rail on
         both surfaces. -->
    <h3 class="kn-api-head" contenteditable="false">
      <select
        v-if="editor.isEditable"
        class="kn-api-method"
        :value="node.attrs.method"
        :aria-label="t('api.changeMethod')"
        @change="commitMethod"
      >
        <option v-for="verb in HTTP_METHODS" :key="verb" :value="verb">{{ verb }}</option>
      </select>
      <span v-else class="kn-api-method">{{ node.attrs.method }}</span>

      <span
        class="kn-api-path"
        :contenteditable="editor.isEditable"
        spellcheck="false"
        :aria-label="t('api.editPath')"
        @blur="commitPath"
        @keydown.enter.prevent="($event.target as HTMLElement).blur()"
        >{{ node.attrs.path }}</span
      >
    </h3>
    <NodeViewContent class="kn-api-body" />
  </NodeViewWrapper>
</template>
