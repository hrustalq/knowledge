<script setup lang="ts">
/**
 * The anonymous reader for a share link (docs/features/43, issue #77).
 *
 * The root of its own small app (public-main.ts): no router, no auth, no
 * workspace stores, no app shell — none of that ships to someone opening a
 * link cold. Every page is a full server render, so moving between pages of a
 * shared subtree is a plain link, and what the reader sees is always what the
 * server just authorised.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, Moon, Sun } from 'lucide-vue-next'
import { formatDate } from '@/shared/utils/format'
import { toggleTheme } from '@/shared/utils/theme'
import PublicMarkdown from '@/modules/reader/components/PublicMarkdown.vue'
import PublicPasswordGate from '@/modules/reader/components/PublicPasswordGate.vue'
import { shareHref, treeRows, type PublicReaderState } from '../model/reader-state'
import ShareDownload from '../components/ShareDownload.vue'

const props = defineProps<{ state: PublicReaderState }>()

const { t } = useI18n()

const view = computed(() => props.state.view)
const share = computed(() => (view.value.kind === 'share' ? view.value : null))
const rootId = computed(() => share.value?.tree[0]?.documentId ?? null)
const rows = computed(() => (share.value && share.value.tree.length > 1 ? treeRows(share.value.tree) : []))
const toc = computed(() => share.value?.page.headings.filter((h) => h.level > 1) ?? [])
const date = (iso: string) => formatDate(iso, props.state.locale)
</script>

<template>
  <div class="min-h-dvh bg-background text-foreground">
    <header class="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
      <div class="flex h-12 items-center gap-3 px-4 lg:px-8">
        <FileText class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <a
          v-if="share"
          :href="shareHref(share.token, null, rootId)"
          class="min-w-0 truncate text-sm font-medium hover:underline"
        >{{ share.title }}</a>
        <span v-else class="text-sm text-muted-foreground">{{ t('shareReader.sharedWithYou') }}</span>
        <span class="flex-1" />
        <span v-if="share?.expiresAt" class="hidden text-xs text-muted-foreground sm:inline">
          {{ t('shareReader.expires', { date: date(share.expiresAt) }) }}
        </span>
        <ShareDownload
          v-if="share?.download"
          :token="share.token"
          :api-base="state.apiBase"
          :title="share.title"
          :subtree="share.tree.length > 1"
          :offer="share.download"
        />
        <button
          type="button"
          class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          :aria-label="t('shareReader.toggleTheme')"
          :title="t('shareReader.toggleTheme')"
          @click="toggleTheme"
        >
          <!-- CSS picks the icon: the server cannot know the reader's theme, and a
               v-if on it would mismatch at hydration. -->
          <Moon class="size-4 dark:hidden" />
          <Sun class="hidden size-4 dark:block" />
        </button>
      </div>
    </header>

    <main v-if="view.kind === 'not-found'" class="mx-auto mt-24 max-w-md space-y-2 px-6 text-center">
      <h1 class="text-lg font-semibold">{{ t('shareReader.notFoundTitle') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('shareReader.notFoundBody') }}</p>
    </main>

    <main v-else-if="view.kind === 'locked'">
      <PublicPasswordGate :token="view.token" :api-base="state.apiBase" />
    </main>

    <!-- The in-app shape: a rail flush with the left edge, a content column
         that fills the rest, and the outline as a third column where there is
         room. The prose fills it too; the narrow measure is in-app only (#422). -->
    <div v-else-if="share" class="flex">
      <nav
        v-if="rows.length"
        class="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:block"
        :aria-label="t('shareReader.pages')"
      >
        <div class="quiet-scroll sticky top-12 h-[calc(100dvh-3rem)] overflow-y-auto px-2 py-4">
          <p class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('shareReader.pages') }}</p>
          <ul class="space-y-px text-sm">
            <li v-for="row in rows" :key="row.documentId">
              <a
                :href="shareHref(share.token, row.documentId, rootId)"
                class="block truncate rounded-md py-1 pr-2 hover:bg-muted"
                :class="row.documentId === share.page.documentId ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/80'"
                :style="{ paddingLeft: `${0.5 + row.depth * 0.875}rem` }"
                :aria-current="row.documentId === share.page.documentId ? 'page' : undefined"
              >{{ row.title }}</a>
            </li>
          </ul>
          <p v-if="share.treeTruncated" class="mt-2 text-xs text-muted-foreground">
            {{ t('shareReader.truncated', { n: share.tree.length }) }}
          </p>
        </div>
      </nav>

      <main class="flex min-w-0 flex-1 gap-8 px-4 py-6 lg:px-8 lg:py-8">
        <article class="min-w-0 flex-1">
          <div>
            <h1 class="mb-1 text-3xl font-semibold tracking-tight">{{ share.page.title }}</h1>
            <p v-if="share.page.updatedAt" class="mb-8 text-xs text-muted-foreground">
              {{ t('shareReader.updated', { date: date(share.page.updatedAt) }) }}
            </p>
            <!-- Pages of the subtree, for readers on a screen too narrow for the side nav. -->
            <details v-if="rows.length" class="mb-6 rounded-md border px-3 py-2 text-sm lg:hidden">
              <summary class="cursor-pointer font-medium">{{ t('shareReader.pages') }}</summary>
              <ul class="mt-2 space-y-1">
                <li v-for="row in rows" :key="row.documentId" :style="{ paddingLeft: `${row.depth * 0.875}rem` }">
                  <a :href="shareHref(share.token, row.documentId, rootId)" class="hover:underline">{{ row.title }}</a>
                </li>
              </ul>
            </details>
            <PublicMarkdown :html="share.page.html" />
          </div>
        </article>

        <aside v-if="toc.length > 1" class="hidden w-52 shrink-0 xl:block" :aria-label="t('shareReader.onThisPage')">
          <div class="sticky top-20">
            <p class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('shareReader.onThisPage') }}</p>
            <ul class="space-y-1 text-sm">
              <li v-for="h in toc" :key="h.id" :style="{ paddingLeft: `${(h.level - 2) * 0.75}rem` }">
                <a :href="`#${h.id}`" class="text-muted-foreground hover:text-foreground">{{ h.text }}</a>
              </li>
            </ul>
          </div>
        </aside>
      </main>
    </div>
  </div>
</template>
