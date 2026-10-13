<script setup lang="ts">
/**
 * The Ask widget's frame (docs/features/44, issue #77 phase 3): what
 * `widget.js` opens on someone else's page, at `<site>/_widget`. The reader's
 * own Ask panel (SiteAsk), with the site's title and a close button, and
 * nothing of the site's pages.
 *
 * It talks to the embed script in two messages and takes none: `ready` once
 * it has mounted with Ask available — only then does the script show its
 * button, so a site that turned Ask off shows nothing — and `close`. They say
 * nothing a stranger could use, so they go to any parent; who may frame this
 * page at all is the response's `frame-ancestors`.
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import SiteAsk from './SiteAsk.vue'
import type { PublicReaderState } from './reader-state'

/** The protocol widget.js listens for; kept in step with server/site-widget.js. */
const MESSAGE_SOURCE = 'kn-site-ask'

const props = defineProps<{ state: PublicReaderState }>()
const { t } = useI18n()
const site = props.state.view.kind === 'site-widget' ? props.state.view.site : null
const panel = ref<InstanceType<typeof SiteAsk> | null>(null)

function post(type: 'ready' | 'close', extra: Record<string, unknown> = {}) {
  if (window.parent !== window) window.parent.postMessage({ source: MESSAGE_SOURCE, type, ...extra }, '*')
}

onMounted(() => {
  if (!site) return
  post('ready', { title: site.title, color: site.theme.primaryColor ?? null, label: t('siteReader.ask') })
  // widget.js asks the frame to take focus when it opens.
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && (e.data as { source?: string; type?: string })?.source === MESSAGE_SOURCE && e.data.type === 'focus') {
      panel.value?.focus()
    }
  })
})
</script>

<template>
  <div class="kn-site flex h-dvh flex-col bg-background text-foreground">
    <template v-if="site">
      <header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <img v-if="site.logo?.kind === 'image'" :src="site.logo.url" alt="" class="size-6 shrink-0 rounded object-cover">
        <span
          v-else-if="site.logo?.kind === 'emoji'"
          class="flex size-6 shrink-0 items-center justify-center rounded text-sm"
          :style="site.logo.color ? { backgroundColor: site.logo.color } : undefined"
          aria-hidden="true"
        >{{ site.logo.emoji }}</span>
        <h1 class="min-w-0 flex-1 truncate text-sm font-semibold">
          <a :href="site.rootUrl" target="_blank" rel="noopener" class="hover:underline">{{ t('siteReader.askTitle', { site: site.title }) }}</a>
        </h1>
        <button
          type="button"
          class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          :aria-label="t('siteReader.askClose')"
          @click="post('close')"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </header>
      <SiteAsk ref="panel" class="min-h-0 flex-1" :site-id="site.id" :site-title="site.title" :api-base="state.apiBase" :version-slug="null" open-in-new-tab />
    </template>
    <p v-else class="m-auto px-6 text-center text-sm text-muted-foreground">{{ t('siteReader.askWidgetUnavailable') }}</p>
  </div>
</template>
