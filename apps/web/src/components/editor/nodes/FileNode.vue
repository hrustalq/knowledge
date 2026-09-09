<script setup lang="ts">
// Attachment embed. PDFs get a real paged viewer via the browser's own PDF
// plugin — no 2 MB of pdf.js for something every target browser already does,
// and the native viewer brings search, zoom and print with it.
import { computed, ref } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Download, ExternalLink, File, FileText, Maximize2, Minimize2, Trash2 } from 'lucide-vue-next'
import { Collapse } from '@/components/ui/collapse'
import { resolveAssetUrl } from '@/lib/api'
import { attachmentKind, formatBytes } from '@/lib/markdown/nodes'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps(nodeViewProps)
const expanded = ref(true)

const mime = computed(() => (props.node.attrs.mime as string) ?? '')
const kind = computed(() => attachmentKind(mime.value))
const href = computed(() => resolveAssetUrl((props.node.attrs.href as string) ?? ''))
const downloadHref = computed(() => {
  const url = href.value
  return `${url}${url.includes('?') ? '&' : '?'}download=1`
})
</script>

<template>
  <NodeViewWrapper class="kn-block kn-file" :data-selected="selected" :data-kind="kind">
    <div class="kn-file-head" contenteditable="false">
      <component :is="kind === 'pdf' ? FileText : File" class="size-4 shrink-0 opacity-70" />
      <span class="kn-file-name">{{ node.attrs.filename }}</span>
      <span v-if="node.attrs.size" class="kn-file-size">{{ formatBytes(Number(node.attrs.size)) }}</span>
      <div class="ml-auto flex items-center gap-0.5">
        <button
          v-if="kind === 'pdf'"
          type="button"
          :aria-label="expanded ? t('editor.collapsePreview') : t('editor.expandPreview')"
          @click="expanded = !expanded"
        >
          <component :is="expanded ? Minimize2 : Maximize2" class="size-3.5" />
        </button>
        <a :href="href" target="_blank" rel="noopener noreferrer" :aria-label="t('editor.openInNewTab')">
          <ExternalLink class="size-3.5" />
        </a>
        <a :href="downloadHref" :download="node.attrs.filename" :aria-label="t('editor.download')">
          <Download class="size-3.5" />
        </a>
        <button v-if="editor.isEditable" type="button" :aria-label="t('editor.removeAttachment')" @click="deleteNode()">
          <Trash2 class="size-3.5" />
        </button>
      </div>
    </div>

    <!-- Unmounted while closed: an <object> left in the tree keeps a PDF
         renderer alive behind a control that says the preview is collapsed. -->
    <Collapse v-if="kind === 'pdf'" :open="expanded">
      <object
        class="kn-file-pdf"
        :data="href"
        type="application/pdf"
        :aria-label="t('editor.previewOf', { name: node.attrs.filename })"
      >
        <div class="kn-file-fallback">
          {{ t('editor.pdfUnsupported') }}
          <a :href="downloadHref" :download="node.attrs.filename">
            {{ t('editor.downloadNamed', { name: node.attrs.filename }) }}
          </a>
        </div>
      </object>
    </Collapse>
  </NodeViewWrapper>
</template>
