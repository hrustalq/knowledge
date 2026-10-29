<script setup lang="ts">
/**
 * A hand-written API block section, read (#78): the author's table drawn in
 * the same key → value grammar as the spec's live rows, with every column's
 * meaning labelled in the reader's language (`modules/api-reference/model/api-block-rows.ts`). The
 * cell values are the author's and are never translated; only what the
 * interface says about them is.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { locationOf, requiredValue, type ApiBlockRow, type ApiSectionKind } from '@/modules/api-reference/model/api-block-rows'
import { statusTone } from '@/modules/api-reference/model/api-spec'
import ApiTone from './ApiTone.vue'

const props = defineProps<{ kind: ApiSectionKind; rows: ApiBlockRow[] }>()
const { t } = useI18n()

const required = computed(() => t('apiRef.required').toLowerCase())
const where = (raw: string) => {
  const loc = locationOf(raw)
  return loc ? t(`apiLink.in.${loc}`) : raw
}
</script>

<template>
  <ul v-if="kind === 'responses'" class="kn-api-kv">
    <li v-for="(r, i) in rows" :key="i" class="items-baseline">
      <ApiTone :tone="statusTone(r.code)" class="self-start">{{ r.code || '—' }}</ApiTone>
      <span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 leading-normal">
        <span v-if="r.description">{{ r.description }}</span>
        <code v-if="r.body" class="kn-api-dim font-mono text-ui">{{ r.body }}</code>
        <span v-for="x in r.extras" :key="x.label" class="kn-api-dim text-ui">{{ x.label }}: {{ x.value }}</span>
      </span>
    </li>
  </ul>

  <dl v-else class="kn-api-kv">
    <div v-for="(r, i) in rows" :key="i">
      <dt>{{ r.name || '—' }}</dt>
      <dd>
        <span v-if="r.type" class="font-mono">{{ r.type }}</span>
        <span v-if="r.in" class="kn-api-dim italic">{{ where(r.in) }}</span>
        <span v-if="requiredValue(r.required) === true" class="kn-api-req">{{ required }}</span>
        <span v-else-if="requiredValue(r.required) === null && r.required" class="kn-api-dim">{{ r.required }}</span>
        <span v-for="x in r.extras" :key="x.label" class="kn-api-dim">{{ x.label }}: {{ x.value }}</span>
        <span v-if="r.description" class="kn-api-note">{{ r.description }}</span>
      </dd>
    </div>
  </dl>
</template>
