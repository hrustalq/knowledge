<script setup lang="ts">
// A whiteboard scene inside the page. Reading is the default state: the node
// shows the finished diagram and only becomes a canvas when asked, so a long
// document is not a wall of toolbars.
import { computed, ref } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import DOMPurify from 'dompurify'
import { Check, PenLine, Trash2 } from 'lucide-vue-next'
import { parseScene, renderSceneToSvg, serializeScene, emptyScene } from '@/core/markdown/drawing'
import Whiteboard from '../Whiteboard.vue'
import { diagramAttrs } from '@knowledge/ui/lightbox'
import { useDiagramLayout } from './diagram-layout'
import DiagramPlacement from './DiagramPlacement.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps(nodeViewProps)
const editing = ref(false)
const { wrap, layoutAttrs, resize, place } = useDiagramLayout(props, editing)

const sceneJson = computed<string>(
  () => (props.node.attrs.scene as string) || serializeScene(emptyScene()),
)
// The scene is page text: parseScene checks it, and the preview is sanitized as
// MarkdownView sanitizes the same SVG (GHSA-qmpf-jh26-7cfm). Node views mount
// only in the browser, where DOMPurify has a DOM.
const preview = computed(() =>
  DOMPurify.sanitize(renderSceneToSvg(parseScene(sceneJson.value)), { USE_PROFILES: { svg: true, svgFilters: true } }),
)
const isEmpty = computed(() => parseScene(sceneJson.value).els.length === 0)

/** Read mode opens the page's lightbox (#476), as MermaidNode does. */
function zoomAttrs() {
  return props.editor.isEditable ? {} : diagramAttrs(t)
}

function update(next: string) {
  props.updateAttributes({ scene: next })
}
</script>

<template>
  <NodeViewWrapper class="kn-block kn-drawing" v-bind="layoutAttrs" :data-selected="selected" :data-editing="editing">
    <div v-if="!editing" class="kn-drawing-view" @dblclick="editor.isEditable && (editing = true)">
      <!-- eslint-disable-next-line vue/no-v-html -- checked by parseScene and sanitized above -->
      <div v-if="!isEmpty" class="kn-drawing-canvas" v-bind="zoomAttrs()" v-html="preview" />
      <div v-else class="kn-drawing-placeholder">
        <PenLine class="size-5 opacity-50" />
        <span>{{ t('editor.emptyDiagram') }}</span>
      </div>
    </div>

    <Whiteboard v-else :model-value="sceneJson" @update:model-value="update" @close="editing = false" />

    <template v-if="editor.isEditable && !editing">
      <span class="kn-resize-grip" data-side="left" @pointerdown="resize($event, 'left')" />
      <span class="kn-resize-grip" data-side="right" @pointerdown="resize($event, 'right')" />
    </template>
    <div v-if="editor.isEditable" class="kn-block-actions" contenteditable="false">
      <button v-if="!editing" type="button" @click="editing = true">
        <PenLine class="size-3.5" /> {{ t('editor.editDiagram') }}
      </button>
      <button v-else type="button" @click="editing = false"><Check class="size-3.5" /> {{ t('editor.done') }}</button>
      <DiagramPlacement v-if="!editing" :wrap="wrap" @place="place" />
      <button type="button" :aria-label="t('editor.deleteDiagram')" @click="deleteNode()"><Trash2 class="size-3.5" /></button>
    </div>
  </NodeViewWrapper>
</template>
