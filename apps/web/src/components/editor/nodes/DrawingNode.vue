<script setup lang="ts">
// A whiteboard scene inside the page. Reading is the default state: the node
// shows the finished diagram and only becomes a canvas when asked, so a long
// document is not a wall of toolbars.
import { computed, ref } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Check, PenLine, Trash2 } from 'lucide-vue-next'
import { parseScene, renderSceneToSvg, serializeScene, emptyScene } from '@/lib/markdown/drawing'
import Whiteboard from '../Whiteboard.vue'

const props = defineProps(nodeViewProps)
const editing = ref(false)

const sceneJson = computed<string>(
  () => (props.node.attrs.scene as string) || serializeScene(emptyScene()),
)
const preview = computed(() => renderSceneToSvg(parseScene(sceneJson.value)))
const isEmpty = computed(() => parseScene(sceneJson.value).els.length === 0)

function update(next: string) {
  props.updateAttributes({ scene: next })
}
</script>

<template>
  <NodeViewWrapper class="kn-block kn-drawing" :data-selected="selected" :data-editing="editing">
    <div v-if="!editing" class="kn-drawing-view" @dblclick="editor.isEditable && (editing = true)">
      <!-- eslint-disable-next-line vue/no-v-html -- SVG built from our own scene model -->
      <div v-if="!isEmpty" class="kn-drawing-canvas" v-html="preview" />
      <div v-else class="kn-drawing-placeholder">
        <PenLine class="size-5 opacity-50" />
        <span>Empty diagram</span>
      </div>
    </div>

    <Whiteboard v-else :model-value="sceneJson" @update:model-value="update" @close="editing = false" />

    <div v-if="editor.isEditable" class="kn-block-actions" contenteditable="false">
      <button v-if="!editing" type="button" @click="editing = true">
        <PenLine class="size-3.5" /> Edit diagram
      </button>
      <button v-else type="button" @click="editing = false"><Check class="size-3.5" /> Done</button>
      <button type="button" aria-label="Delete diagram" @click="deleteNode()"><Trash2 class="size-3.5" /></button>
    </div>
  </NodeViewWrapper>
</template>
