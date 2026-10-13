<script setup lang="ts">
/**
 * Search over the published version a reader is on (docs/features/44, issue
 * #77 phase 2b-2). The app's own search sheet, minus its stores: the same
 * `Sheet`, the same "/" and ⌘K shortcut and the same focus return
 * (lib/search-shortcut.ts). Results come from the public search route, which
 * reads only this version's snapshot.
 *
 * The one part of the reader that needs JavaScript: every page is still a
 * plain server render, and a result is a plain link to one.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Search } from 'lucide-vue-next'
import {
  SITE_SEARCH_MIN_CHARS,
  publicSiteSearchPath,
  type PublicSiteSearchResponse,
  type PublicSiteSearchResult,
} from '@knowledge/contracts/publishing'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { createFocusReturn, isSearchShortcut } from '@/lib/search-shortcut'
import { siteHomeId, siteHref, type PublicSiteChrome } from './reader-state'

const props = defineProps<{ site: PublicSiteChrome; apiBase: string }>()

const { t } = useI18n()

const open = ref(false)
const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const results = ref<PublicSiteSearchResult[]>([])
const state = ref<'idle' | 'loading' | 'done' | 'failed' | 'limited'>('idle')
const active = ref(0)

const homeId = computed(() => siteHomeId(props.site.tree))
const hrefOf = (r: PublicSiteSearchResult) => siteHref(props.site, props.site.version, r.slugPath, r.documentId === homeId.value)
const tooShort = computed(() => query.value.trim().length < SITE_SEARCH_MIN_CHARS)

let timer: ReturnType<typeof setTimeout> | undefined
let inflight: AbortController | undefined

async function run(q: string) {
  inflight?.abort()
  const controller = new AbortController()
  inflight = controller
  state.value = 'loading'
  const params = new URLSearchParams({ q })
  if (!props.site.version.isDefault) params.set('version', props.site.version.slug)
  try {
    const res = await fetch(`${props.apiBase}${publicSiteSearchPath(props.site.id)}?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (res.status === 429) {
      state.value = 'limited'
      return
    }
    if (!res.ok) throw new Error(String(res.status))
    results.value = ((await res.json()) as PublicSiteSearchResponse).results
    active.value = 0
    state.value = 'done'
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    state.value = 'failed'
  }
}

watch(query, (q) => {
  clearTimeout(timer)
  if (q.trim().length < SITE_SEARCH_MIN_CHARS) {
    inflight?.abort()
    results.value = []
    state.value = 'idle'
    return
  }
  timer = setTimeout(() => void run(q.trim()), 150)
})

const focusReturn = createFocusReturn('site-search-trigger')
watch(open, (isOpen) => {
  if (isOpen) focusReturn.remember()
})

/** Focus the query rather than the close button, with any previous query selected. */
function focusQuery() {
  void nextTick(() => input.value?.select())
}

function onKey(e: KeyboardEvent) {
  if (results.value.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    const n = results.value.length
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    document.getElementById(`kn-search-${active.value}`)?.scrollIntoView({ block: 'nearest' })
  } else if (e.key === 'Enter' && results.value[active.value]) {
    e.preventDefault()
    window.location.href = hrefOf(results.value[active.value])
  }
}

function onGlobalKey(e: KeyboardEvent) {
  if (!isSearchShortcut(e)) return
  e.preventDefault()
  open.value = true
}

onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey)
  clearTimeout(timer)
  inflight?.abort()
})
</script>

<template>
  <button
    id="site-search-trigger"
    type="button"
    class="inline-flex h-8 items-center gap-2 rounded-md border px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground sm:w-56"
    aria-haspopup="dialog"
    :aria-label="t('siteReader.search')"
    @click="open = true"
  >
    <Search class="size-4 shrink-0" aria-hidden="true" />
    <span class="hidden flex-1 text-left sm:inline">{{ t('siteReader.search') }}</span>
    <kbd class="hidden rounded border bg-muted px-1.5 font-mono text-[10px] sm:inline">/</kbd>
  </button>

  <Sheet v-model:open="open">
    <SheetContent
      side="right"
      class="w-full gap-0 p-0 sm:max-w-xl"
      @open-auto-focus.prevent="focusQuery"
      @close-auto-focus="focusReturn.onCloseAutoFocus"
    >
      <SheetHeader class="sr-only">
        <SheetTitle>{{ t('siteReader.search') }}</SheetTitle>
        <SheetDescription>{{ t('siteReader.searchPlaceholder') }}</SheetDescription>
      </SheetHeader>

      <div class="flex items-center gap-2 border-b pr-12 pl-4">
        <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref="input"
          v-model="query"
          type="text"
          enterkeyhint="search"
          class="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          :placeholder="t('siteReader.searchPlaceholder')"
          :aria-label="t('siteReader.searchPlaceholder')"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="kn-search-results"
          :aria-expanded="results.length > 0"
          :aria-activedescendant="results.length ? `kn-search-${active}` : undefined"
          maxlength="200"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKey"
        >
        <Loader2 v-if="state === 'loading'" class="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-2" aria-live="polite">
        <ul v-if="results.length" id="kn-search-results" role="listbox" :aria-label="t('siteReader.searchResults')" class="space-y-1">
          <li
            v-for="(r, i) in results"
            :id="`kn-search-${i}`"
            :key="r.documentId"
            role="option"
            :aria-selected="i === active"
          >
            <a
              :href="hrefOf(r)"
              class="block rounded-md px-3 py-2"
              :class="i === active ? 'bg-primary/10' : 'hover:bg-muted'"
              @mouseenter="active = i"
            >
              <span class="block truncate text-sm font-medium" :class="i === active ? 'text-primary' : ''">{{ r.title }}</span>
              <span v-if="r.snippet.length" class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                <template v-for="(part, j) in r.snippet" :key="j">
                  <mark v-if="part.hit" class="rounded-sm bg-primary/15 px-0.5 text-foreground">{{ part.text }}</mark>
                  <template v-else>{{ part.text }}</template>
                </template>
              </span>
            </a>
          </li>
        </ul>
        <p v-else-if="state === 'done'" class="px-3 py-6 text-center text-sm text-muted-foreground">
          {{ t('siteReader.searchEmpty', { query: query.trim() }) }}
        </p>
        <p v-else-if="state === 'limited'" class="px-3 py-6 text-center text-sm text-muted-foreground">
          {{ t('siteReader.searchRateLimited') }}
        </p>
        <p v-else-if="state === 'failed'" class="px-3 py-6 text-center text-sm text-muted-foreground">
          {{ t('siteReader.searchFailed') }}
        </p>
        <p v-else-if="tooShort" class="px-3 py-6 text-center text-sm text-muted-foreground">
          {{ t('siteReader.searchHint') }}
        </p>
      </div>
    </SheetContent>
  </Sheet>
</template>
