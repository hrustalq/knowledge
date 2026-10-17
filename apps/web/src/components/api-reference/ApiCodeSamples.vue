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
import { computed, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy } from 'lucide-vue-next'
import { CODE_SAMPLE_LANGS, type CodeSample, type CodeSampleLang } from '@knowledge/contracts'
import { useCopy } from '@/lib/use-copy'

const props = defineProps<{ samples: CodeSample[] }>()
const { t } = useI18n()
const { state: copyState, copy } = useCopy()
const uid = useId()

const lang = useSampleLang()
const current = computed(() => props.samples.find((s) => s.lang === lang.value) ?? props.samples[0])

const LABELS: Record<CodeSampleLang, string> = { curl: 'cURL', javascript: 'JavaScript', python: 'Python', go: 'Go' }

function onKeydown(event: KeyboardEvent) {
  const langs = props.samples.map((s) => s.lang)
  const from = langs.indexOf(current.value?.lang ?? 'curl')
  const to =
    event.key === 'ArrowRight' ? (from + 1) % langs.length
    : event.key === 'ArrowLeft' ? (from - 1 + langs.length) % langs.length
    : event.key === 'Home' ? 0
    : event.key === 'End' ? langs.length - 1
    : -1
  if (to < 0) return
  event.preventDefault()
  lang.value = langs[to]
  document.getElementById(`${uid}-${langs[to]}`)?.focus()
}
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
  <div v-if="current" class="min-w-0">
    <div class="flex items-end justify-between gap-3 border-b">
      <div role="tablist" :aria-label="t('apiSamples.label')" class="-mb-px flex min-w-0 overflow-x-auto" @keydown="onKeydown">
        <button
          v-for="s in samples"
          :id="`${uid}-${s.lang}`"
          :key="s.lang"
          type="button"
          role="tab"
          :aria-selected="s.lang === current.lang"
          :aria-controls="`${uid}-panel`"
          :tabindex="s.lang === current.lang ? 0 : -1"
          class="shrink-0 rounded-t-sm border-b-2 px-2.5 py-1.5 text-[0.8rem] whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          :class="s.lang === current.lang ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="lang = s.lang"
        >
          {{ LABELS[s.lang] }}
        </button>
      </div>
      <button
        type="button"
        class="mb-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.75rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :title="copyState === 'failed' ? t('apiSamples.copyFailed') : undefined"
        @click="copy(current.source)"
      >
        <Check v-if="copyState === 'copied'" class="size-3.5" />
        <Copy v-else class="size-3.5" />
        <!-- The word only where there is room for it; below `sm` the four tabs need the width. -->
        <span aria-live="polite" class="sr-only sm:not-sr-only">{{ copyState === 'copied' ? t('apiSamples.copied') : copyState === 'failed' ? t('apiSamples.copyFailedShort') : t('apiSamples.copy') }}</span>
      </button>
    </div>
    <pre
      :id="`${uid}-panel`"
      role="tabpanel"
      :aria-labelledby="`${uid}-${current.lang}`"
      tabindex="0"
      class="kn-sample mt-2 max-h-[26rem] overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-[0.78rem] leading-[1.6]"
    ><code>{{ current.source }}</code></pre>
    <p v-if="current.origin === 'spec'" class="mt-1.5 text-[0.75rem] text-muted-foreground">
      {{ current.label ? t('apiSamples.fromSpecLabelled', { label: current.label }) : t('apiSamples.fromSpec') }}
    </p>
  </div>
</template>

<style scoped>
.kn-sample {
  tab-size: 4;
  font-variant-ligatures: none;
}
</style>
