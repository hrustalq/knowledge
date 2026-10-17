<script setup lang="ts">
/**
 * A hand-written API block section, read (#78): the author's table drawn in
 * the same key → value grammar as the spec's live rows, with every column's
 * meaning labelled in the reader's language (`lib/api-block-rows.ts`). The
 * cell values are the author's and are never translated; only what the
 * interface says about them is.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { locationOf, requiredValue, type ApiBlockRow, type ApiSectionKind } from '@/lib/api-block-rows'
import { statusTone } from '@/lib/api-spec'
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
      <span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 leading-snug">
        <span v-if="r.description">{{ r.description }}</span>
        <code v-if="r.body" class="font-mono text-[0.76rem] text-muted-foreground">{{ r.body }}</code>
        <span v-for="x in r.extras" :key="x.label" class="text-[0.76rem] text-muted-foreground">{{ x.label }}: {{ x.value }}</span>
      </span>
    </li>
  </ul>

  <dl v-else class="kn-api-kv">
    <div v-for="(r, i) in rows" :key="i">
      <dt>{{ r.name || '—' }}</dt>
      <dd>
        <span v-if="r.type" class="font-mono">{{ r.type }}</span>
        <span v-if="r.in" class="text-muted-foreground">{{ where(r.in) }}</span>
        <span v-if="requiredValue(r.required) === true" class="kn-api-req">{{ required }}</span>
        <span v-else-if="requiredValue(r.required) === null && r.required" class="text-muted-foreground">{{ r.required }}</span>
        <span v-for="x in r.extras" :key="x.label" class="text-muted-foreground">{{ x.label }}: {{ x.value }}</span>
        <span v-if="r.description" class="basis-full text-[0.8rem] leading-snug text-muted-foreground">{{ r.description }}</span>
      </dd>
    </div>
  </dl>
</template>
