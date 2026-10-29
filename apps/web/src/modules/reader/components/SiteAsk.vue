<script setup lang="ts">
/**
 * A published site's Ask (docs/features/44, issue #77 phase 3): one question,
 * one answer from the site's own pages, each sentence's `[S#]` a chip that
 * opens the page it rests on. The same panel sits in the reader's sheet
 * (SitePage) and in the widget's frame (SiteWidget), so the two cannot drift.
 *
 * Client-only by nature — there is nothing to render before someone asks — so
 * the markdown parser and the citation pass load on the first answer, and the
 * reader's own bundle stays the size it was. The answer is sanitized here with
 * the app's SANITIZE_CONFIG, as MarkdownView does; the API sends markdown.
 */
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, BookOpen, Loader2 } from 'lucide-vue-next'
import {
  SITE_ASK_MAX_CHARS,
  SITE_ASK_MIN_CHARS,
  publicSiteAskPath,
  type PublicSiteAskResponse,
  type PublicSiteAskSource,
} from '@knowledge/contracts/publishing'
import { isApiErrorPayload } from '@knowledge/contracts'
import { Button } from '@/shared/ui/button'
import { loadCitations } from '@/entities/assistant'
import '@/assets/styles/citations.css'

const props = defineProps<{
  siteId: string
  siteTitle: string
  apiBase: string
  /** Null for the default version. */
  versionSlug: string | null
  /** In the widget a source opens the site in a new tab; in the reader, in place. */
  openInNewTab?: boolean
}>()

const { t } = useI18n()

const question = ref('')
const asked = ref('')
const state = ref<'idle' | 'loading' | 'done' | 'failed' | 'limited' | 'exhausted' | 'unavailable'>('idle')
const answer = ref<PublicSiteAskResponse | null>(null)
const html = ref('')
const body = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
let inflight: AbortController | undefined

const canAsk = computed(() => state.value !== 'loading' && question.value.trim().length >= SITE_ASK_MIN_CHARS)
const target = computed(() => (props.openInNewTab ? '_blank' : undefined))

/** A source's link: the page, at the section the passage sits under. */
let anchorOf: (headingPath: string[]) => string = () => ''
function hrefOf(source: PublicSiteAskSource): string {
  const anchor = anchorOf(source.headingPath)
  return `${source.url}${anchor ? `#${anchor}` : ''}`
}

async function render(res: PublicSiteAskResponse) {
  const [{ markdownToHtml, SANITIZE_CONFIG }, cites, { default: DOMPurify }] = await Promise.all([
    import('@/core/markdown/render'),
    loadCitations(),
    import('dompurify'),
  ])
  anchorOf = (path) => cites.headingAnchor(path)
  html.value = DOMPurify.sanitize(markdownToHtml(res.answer), SANITIZE_CONFIG)
  await nextTick()
  if (body.value) {
    for (const a of body.value.querySelectorAll('a[href]')) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer nofollow')
    }
    cites.decorateCitations(body.value, new Set(res.sources.map((s) => s.cite)))
    // Sentences the decision model found unsupported (#530), when the site's workspace checks.
    cites.markUnsupported(body.value, cites.unsupportedMarkers(res.answer, res.citations), t('siteReader.askUnsupported'))
  }
}

async function ask() {
  if (!canAsk.value) return
  inflight?.abort()
  const controller = new AbortController()
  inflight = controller
  asked.value = question.value.trim()
  question.value = ''
  state.value = 'loading'
  answer.value = null
  html.value = ''
  try {
    const res = await fetch(`${props.apiBase}${publicSiteAskPath(props.siteId)}`, {
      method: 'POST',
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: asked.value.slice(0, SITE_ASK_MAX_CHARS), ...(props.versionSlug ? { version: props.versionSlug } : {}) }),
    })
    if (!res.ok) {
      const payload: unknown = await res.json().catch(() => null)
      const reason = isApiErrorPayload(payload) ? (payload.details as { reason?: string } | undefined)?.reason : undefined
      state.value =
        res.status === 429 ? (reason === 'publicAsk.budgetExhausted' ? 'exhausted' : 'limited') : res.status === 503 || res.status === 404 ? 'unavailable' : 'failed'
      return
    }
    const data = (await res.json()) as PublicSiteAskResponse
    answer.value = data
    state.value = 'done'
    if (data.answer) await render(data)
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    state.value = 'failed'
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void ask()
  }
}

/** A chip opens the page its label names. */
function onAnswerClick(e: MouseEvent) {
  const cite = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.kn-cite')?.dataset.cite
  const source = cite ? answer.value?.sources.find((s) => s.cite === cite) : undefined
  if (!source) return
  e.preventDefault()
  if (props.openInNewTab) window.open(hrefOf(source), '_blank', 'noopener')
  else window.location.href = hrefOf(source)
}

function again() {
  question.value = ''
  state.value = 'idle'
  answer.value = null
  html.value = ''
  void nextTick(() => input.value?.focus())
}

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
      <p v-if="state === 'idle'" class="text-sm text-muted-foreground">{{ t('siteReader.askDescription') }}</p>

      <template v-else>
        <p class="mb-3 rounded-lg bg-muted px-3 py-2 text-sm">{{ asked }}</p>

        <p v-if="state === 'loading'" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" aria-hidden="true" />{{ t('siteReader.askThinking') }}
        </p>
        <p v-else-if="state === 'limited'" role="alert" class="text-sm text-muted-foreground">{{ t('siteReader.askRateLimited') }}</p>
        <p v-else-if="state === 'exhausted'" role="alert" class="text-sm text-muted-foreground">{{ t('siteReader.askBudgetExhausted') }}</p>
        <p v-else-if="state === 'unavailable'" role="alert" class="text-sm text-muted-foreground">{{ t('siteReader.askUnavailable') }}</p>
        <p v-else-if="state === 'failed'" role="alert" class="text-sm text-muted-foreground">{{ t('siteReader.askFailed') }}</p>
        <p v-else-if="answer && !answer.answer" class="text-sm text-muted-foreground">{{ t('siteReader.askNoAnswer') }}</p>

        <template v-else-if="answer">
          <!-- eslint-disable-next-line vue/no-v-html -- sanitized above with the app's SANITIZE_CONFIG -->
          <div ref="body" class="markdown-body max-w-none text-sm" @click="onAnswerClick" v-html="html" />

          <div v-if="answer.sources.length" class="mt-4 border-t pt-3">
            <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('siteReader.askSources') }}</h3>
            <ol class="space-y-1">
              <li v-for="s in answer.sources" :key="s.cite">
                <a
                  :href="hrefOf(s)"
                  :target="target"
                  :rel="openInNewTab ? 'noopener' : undefined"
                  class="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <span class="kn-cite mt-0.5 shrink-0">{{ s.cite.slice(1) }}</span>
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ s.title }}</span>
                    <span v-if="s.headingPath.length" class="block truncate text-xs text-muted-foreground">{{ s.headingPath.join(' › ') }}</span>
                  </span>
                </a>
              </li>
            </ol>
          </div>
          <p class="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <BookOpen class="size-3.5" aria-hidden="true" />{{ t('siteReader.askDisclaimer') }}
          </p>
        </template>

        <button v-if="state !== 'loading'" type="button" class="mt-4 text-sm font-medium text-primary hover:underline" @click="again">
          {{ t('siteReader.askAgain') }}
        </button>
      </template>
    </div>

    <form class="flex items-end gap-2 border-t p-3" @submit.prevent="ask">
      <textarea
        ref="input"
        v-model="question"
        rows="2"
        :maxlength="SITE_ASK_MAX_CHARS"
        class="min-h-10 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        :placeholder="t('siteReader.askPlaceholder')"
        :aria-label="t('siteReader.askPlaceholder')"
        @keydown="onKey"
      />
      <Button type="submit" size="icon" :disabled="!canAsk" :aria-label="t('siteReader.askSubmit')">
        <Loader2 v-if="state === 'loading'" class="size-4 animate-spin" aria-hidden="true" />
        <ArrowUp v-else class="size-4" aria-hidden="true" />
      </Button>
    </form>
  </div>
</template>
