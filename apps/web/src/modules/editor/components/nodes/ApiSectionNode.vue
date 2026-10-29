<script setup lang="ts">
// One section of a contract. The marker attribute exists so the OpenAPI
// exporter can find the section without matching its (translated) heading text.
//
// Read, every section but the summary is a disclosure labelled by its kind in
// the reader's language, its filled-in rows as the count, and its table drawn
// as key → value rows (ApiBlockRows) — the stored heading and column headers
// are the author's content and may be in another language. The table itself
// stays in the DOM, hidden, so the document is unchanged underneath. A section
// holding nothing but its label (the template's empty request body) is hidden.
// Written, there is no disclosure and no redraw: the table is where the author
// types.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import ApiDisclosure from '@/modules/api-reference/components/ApiDisclosure.vue'
import ApiBlockRows from '@/modules/api-reference/components/ApiBlockRows.vue'
import { isApiSectionKind, readApiBlockRows } from '@/modules/api-reference/model/api-block-rows'
import { sectionLabel, sectionTable, writtenText } from './api-block-text'

const props = defineProps(nodeViewProps)
const { t, te } = useI18n()

const kind = computed(() => String(props.node.attrs.kind ?? 'summary'))
const reading = computed(() => !props.editor.isEditable)
const empty = computed(() => !writtenText(props.node))
const label = computed(() =>
  te(`api.section.${kind.value}`) ? t(`api.section.${kind.value}`) : sectionLabel(props.node) || kind.value,
)
const rows = computed(() => {
  const k = kind.value
  const table = isApiSectionKind(k) ? sectionTable(props.node) : null
  return table && isApiSectionKind(k) ? readApiBlockRows(k, table.headers, table.rows) : null
})
const open = ref(false)
</script>

<template>
  <NodeViewWrapper
    class="kn-api-section"
    :class="{ 'kn-api-section--empty': empty && reading }"
    :data-kn-api-section="kind"
  >
    <NodeViewContent v-if="kind === 'summary'" />
    <ApiDisclosure v-else v-model:open="open" :label="label" :count="rows?.length || null" :collapsible="reading">
      <ApiBlockRows v-if="reading && rows" :kind="kind as 'params'" :rows="rows" />
      <div :hidden="reading && rows ? true : undefined">
        <NodeViewContent />
      </div>
    </ApiDisclosure>
  </NodeViewWrapper>
</template>
