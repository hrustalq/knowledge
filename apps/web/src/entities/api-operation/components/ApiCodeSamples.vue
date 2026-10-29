<script setup lang="ts">
/**
 * One operation's code samples (#78): a tab per language, the source as text,
 * and a copy button that says whether it worked. The samples come from
 * `@knowledge/contracts` — the generator the samples route and the MCP tool
 * use — so the page, the API and an agent print the same request.
 *
 * A sample the spec's author wrote (`x-codeSamples`) says so under the code:
 * it is theirs, and it will not follow the values typed into the console.
 *
 * The chosen language is the reader's, not the card's: picking Python on one
 * operation shows Python on all of them, and is remembered in this browser.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CODE_SAMPLE_LANGS, type CodeSample, type CodeSampleLang } from '@knowledge/contracts'
import ApiCode, { type ApiCodeLang } from './ApiCode.vue'
import ApiTabs from './ApiTabs.vue'

const props = defineProps<{ samples: CodeSample[] }>()
const { t } = useI18n()

const lang = useSampleLang()
const current = computed(() => props.samples.find((s) => s.lang === lang.value) ?? props.samples[0])
const tabs = computed(() => props.samples.map((s) => ({ id: s.lang, label: LABELS[s.lang] })))
const strip = ref<InstanceType<typeof ApiTabs> | null>(null)

// Product names, the same in every language.
const LABELS: Record<CodeSampleLang, string> = { curl: 'cURL', javascript: 'JavaScript', python: 'Python', go: 'Go' }
const GRAMMAR: Record<CodeSampleLang, ApiCodeLang> = { curl: 'bash', javascript: 'javascript', python: 'python', go: 'go' }
</script>

<script lang="ts">
const STORAGE_KEY = 'kn_sample_lang'
// Shared by every card on the page. Read from storage after mount only, so the
// server render and hydration both start from cURL and never disagree.
const shared = ref<CodeSampleLang>('curl')
let restored = false

function useSampleLang() {
  onMounted(() => {
    if (restored) return
    restored = true
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved && (CODE_SAMPLE_LANGS as readonly string[]).includes(saved)) shared.value = saved as CodeSampleLang
    } catch {
      // Storage refused: the choice lasts for this page.
    }
  })
  watch(shared, (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      /* as above */
    }
  })
  return shared
}
</script>

<template>
  <div v-if="current" class="min-w-0 space-y-2.5">
    <ApiTabs ref="strip" :model-value="current.lang" :tabs="tabs" :label="t('apiSamples.label')" size="sm" @update:model-value="(v) => (lang = v as CodeSampleLang)" />
    <div :id="strip?.panelId(current.lang)" :key="current.lang" role="tabpanel" :aria-labelledby="strip?.tabId(current.lang)" class="kn-fade-swap">
      <ApiCode :code="current.source" :lang="GRAMMAR[current.lang]" :label="LABELS[current.lang]" />
    </div>
    <p v-if="current.origin === 'spec'" class="text-ui text-muted-foreground">
      {{ current.label ? t('apiSamples.fromSpecLabelled', { label: current.label }) : t('apiSamples.fromSpec') }}
    </p>
  </div>
</template>
