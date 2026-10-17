<script setup lang="ts">
/**
 * One body of an operation (#78) — a request body, a response, a message
 * payload — as Swagger draws it: an Example tab and a Schema tab over the same
 * media type. Several media types share one strip, with the type picked beside
 * it.
 *
 * The example is the spec's own when it gives one. Otherwise it is built from
 * the schema by the contracts generator — the same one the code samples use —
 * and says so, so nobody mistakes a value made up from a type for one the
 * author wrote.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { exampleForSchema } from '@knowledge/contracts'
import { schemaTree, typeLabel, type ContentView } from '@/lib/api-spec'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import ApiCode, { type ApiCodeLang } from './ApiCode.vue'
import ApiSchema from './ApiSchema.vue'
import ApiTabs from './ApiTabs.vue'

const props = defineProps<{ document: Record<string, unknown>; contents: ContentView[] }>()
const { t } = useI18n()

const mediaType = ref(props.contents[0]?.mediaType ?? '')
const current = computed(() => props.contents.find((c) => c.mediaType === mediaType.value) ?? props.contents[0] ?? null)
const tree = computed(() => (current.value ? schemaTree(props.document, current.value.schema) : []))

const example = computed(() => {
  const c = current.value
  if (!c) return null
  const own = c.example !== undefined
  const value = own ? c.example : exampleForSchema(props.document, c.schema)
  if (value === null || value === undefined) return null
  return { own, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
})
const lang = computed<ApiCodeLang | null>(() => {
  const m = current.value?.mediaType ?? ''
  if (/json/iu.test(m)) return 'json'
  if (/xml|html/iu.test(m)) return 'xml'
  return null
})

const tabs = computed(() =>
  [
    example.value && { id: 'example', label: t('apiRef.tab.example') },
    tree.value.length > 0 && { id: 'schema', label: t('apiRef.tab.schema') },
  ].filter((x): x is { id: string; label: string } => !!x),
)
const tab = ref<string>('example')
const shown = computed(() => (tabs.value.some((x) => x.id === tab.value) ? tab.value : (tabs.value[0]?.id ?? null)))
const strip = ref<InstanceType<typeof ApiTabs> | null>(null)
</script>

<template>
  <div v-if="current" class="min-w-0 space-y-2.5">
    <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <ApiTabs
        v-if="tabs.length"
        ref="strip"
        :model-value="shown ?? ''"
        :tabs="tabs"
        :label="t('apiRef.tab.label')"
        size="sm"
        class="min-w-0 flex-1"
        @update:model-value="(v) => (tab = v)"
      />
      <Select v-if="contents.length > 1" v-model="mediaType">
        <SelectTrigger class="h-7 w-auto max-w-full font-mono text-[0.75rem]" :aria-label="t('apiTry.contentType')"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="c in contents" :key="c.mediaType" :value="c.mediaType" class="font-mono text-[0.75rem]">{{ c.mediaType }}</SelectItem>
        </SelectContent>
      </Select>
      <code v-else-if="shown !== 'example'" class="pb-1.5 font-mono text-[0.75rem] text-muted-foreground">{{ current.mediaType }}</code>
    </div>

    <div v-if="shown === 'example' && example" :id="strip?.panelId('example')" role="tabpanel" :aria-labelledby="strip?.tabId('example')" class="kn-fade-swap space-y-1.5">
      <ApiCode :code="example.text" :lang="lang" :caption="current.mediaType" max-height="20rem" />
      <p v-if="!example.own" class="text-[0.75rem] text-muted-foreground">{{ t('apiRef.generatedExample') }}</p>
    </div>
    <div v-else-if="shown === 'schema'" :id="strip?.panelId('schema')" role="tabpanel" :aria-labelledby="strip?.tabId('schema')" class="kn-fade-swap">
      <ApiSchema :document="document" :nodes="tree" :type="typeLabel(document, current.schema)" />
    </div>
    <p v-else class="text-[0.85rem] text-muted-foreground">{{ t('apiRef.noSchema') }}</p>
  </div>
</template>
