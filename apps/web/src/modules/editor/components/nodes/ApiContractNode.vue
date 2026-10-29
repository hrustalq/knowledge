<script setup lang="ts">
// One documented HTTP endpoint. The header is the only structured part; the
// body below it is ordinary editable content (NodeViewContent), so tables,
// prose and panels all work inside a contract — and so every description still
// reaches the chunker when this serializes to markdown.
//
// Linked to a spec operation (#78), the block stops being hand-written: the
// method and path come from the spec, the body keeps only the author's summary,
// and the parameters and responses are drawn live from the spec below it. The
// page then IMPLEMENTS the operation, which is what the worker reads off `op`.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import type { JSONContent } from '@tiptap/core'
import { ArrowUpRight, Check, Copy, Route, Unlink } from 'lucide-vue-next'
import { HTTP_METHODS, isHttpMethod, type HttpMethod } from '@/core/markdown/nodes'
import { getWorkspaceId } from '@/shared/api/api'
import { useCopy } from '@/shared/composables/use-copy'
import { pathSegments } from '@/modules/api-reference/model/api-spec'
import { writtenText } from './api-block-text'
import ApiOperationPicker, { type PickedOperation } from '@/modules/api-reference/components/ApiOperationPicker.vue'
import ApiOperationEmbed from '@/modules/api-reference/components/ApiOperationEmbed.vue'
import { operationHref, useOperation } from '@/modules/api-reference/model/use-operation'

const { t } = useI18n()
const props = defineProps(nodeViewProps)

const workspaceId = getWorkspaceId()
const linked = computed(() => (props.node.attrs.op as string | null) || null)
// Shares the embed's query, so the header's spec name costs no second request.
const { operation } = useOperation(workspaceId, linked)
const pathEditable = computed(() => props.editor.isEditable && !linked.value)
const { state: copyState, copy } = useCopy()
const copyLabel = computed(() =>
  copyState.value === 'copied' ? t('apiLink.block.copied') : t('apiLink.block.copy'),
)
const segments = computed(() => pathSegments(String(props.node.attrs.path ?? '/')))

/** Read, a block with nothing written and nothing linked is just its header. */
const bare = computed(() => {
  if (props.editor.isEditable || linked.value) return false
  let text = ''
  props.node.forEach((section) => (text += writtenText(section)))
  return !text
})

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

/**
 * Re-cut the block around the operation: method and path from the spec, and
 * only the summary section kept. The hand-written tables would otherwise sit
 * under the live ones, indexed and silently drifting from the spec. One
 * transaction, so Undo brings them all back.
 */
function link(op: PickedOperation) {
  const pos = props.getPos()
  if (typeof pos !== 'number') return
  const method = (op.method ?? '').toUpperCase()
  const summary = (props.node.toJSON().content as JSONContent[] | undefined)?.find((c) => c.attrs?.kind === 'summary')
  props.editor
    .chain()
    .focus()
    .insertContentAt(
      { from: pos, to: pos + props.node.nodeSize },
      {
        type: 'knApi',
        attrs: { method: isHttpMethod(method) ? method : props.node.attrs.method, path: op.path, op: op.entityKey },
        content: [summary ?? { type: 'knApiSection', attrs: { kind: 'summary' }, content: [{ type: 'paragraph' }] }],
      },
    )
    .run()
}

function unlink() {
  props.updateAttributes({ op: null })
}
</script>

<template>
  <NodeViewWrapper
    class="kn-api"
    :class="{ 'kn-api--bare': bare }"
    :data-kn-api="node.attrs.method"
    :data-kn-op="linked ?? undefined"
  >
    <!-- An <h3>, not a <div>: the read view and the editor both build the page
         outline from h1–h3, so this is what puts the endpoint in the rail on
         both surfaces. -->
    <h3 class="kn-api-head" contenteditable="false">
      <select
        v-if="pathEditable"
        class="kn-api-method"
        :value="node.attrs.method"
        :aria-label="t('api.changeMethod')"
        @change="commitMethod"
      >
        <option v-for="verb in HTTP_METHODS" :key="verb" :value="verb">{{ verb }}</option>
      </select>
      <span v-else class="kn-api-method">{{ node.attrs.method }}</span>

      <span
        v-if="pathEditable"
        class="kn-api-path"
        contenteditable="true"
        spellcheck="false"
        :aria-label="t('api.editPath')"
        @blur="commitPath"
        @keydown.enter.prevent="($event.target as HTMLElement).blur()"
        >{{ node.attrs.path }}</span
      >
      <span v-else class="kn-api-path"
        ><template v-for="(seg, i) in segments" :key="i"
          ><span v-if="seg.param" class="kn-api-param">{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template
        ></span
      >

      <span class="kn-api-actions" data-kn-anno-ui>
        <template v-if="linked">
          <RouterLink
            v-if="operation && !editor.isEditable"
            :to="operationHref(operation)"
            class="kn-api-action"
            :title="t('apiLink.live.open')"
          >
            <Route class="size-3.5 shrink-0" /><span class="truncate">{{ operation.specTitle }}</span><ArrowUpRight class="size-3.5 shrink-0" />
          </RouterLink>
          <span v-else-if="editor.isEditable" class="kn-api-linked" :title="linked">
            <Route class="size-3.5 shrink-0" /><span>{{ operation?.specTitle ?? t('apiLink.block.linked') }}</span>
          </span>
          <button
            v-if="editor.isEditable"
            type="button"
            class="kn-api-action"
            :aria-label="t('apiLink.block.unlink')"
            :title="t('apiLink.block.unlink')"
            @click="unlink"
          >
            <Unlink class="size-3.5" />
          </button>
        </template>
        <ApiOperationPicker v-else-if="editor.isEditable" :workspace-id="workspaceId" protocol="http" align="end" @pick="link">
          <template #trigger="{ toggle }">
            <button type="button" class="kn-api-action" @click="toggle">
              <Route class="size-3.5" />{{ t('apiLink.block.link') }}
            </button>
          </template>
        </ApiOperationPicker>
        <button
          v-if="!editor.isEditable"
          type="button"
          class="kn-api-action"
          :aria-label="copyLabel"
          :title="copyLabel"
          @click="copy(`${node.attrs.method} ${node.attrs.path}`)"
        >
          <Check v-if="copyState === 'copied'" class="size-3.5" />
          <Copy v-else class="size-3.5" />
        </button>
        <span class="sr-only" aria-live="polite">{{ copyState === 'copied' ? t('apiLink.block.copied') : '' }}</span>
      </span>
    </h3>
    <NodeViewContent class="kn-api-body" />
    <ApiOperationEmbed v-if="linked" :workspace-id="workspaceId" :entity-key="linked" />
  </NodeViewWrapper>
</template>
