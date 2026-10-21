<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type { ChatSearchAvailability } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { PageLayout, PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/components/layout/page'
import SearchWidget from '@/components/knowledge/SearchWidget.vue'
import ChatSearchWidget from '@/components/knowledge/ChatSearchWidget.vue'

const { t } = useI18n()

const route = useRoute()
const q = computed(() => (typeof route.query.q === 'string' ? route.query.q : undefined))

// #339: Chat is a tab only for someone who may read a searchable group; page
// results never mix with it. `?tab=chat` is an opening instruction.
const chat = useQuery(apiQueryOptions('/v1/chat/search', { query: { workspaceId: getWorkspaceId() } }))
const chatReadable = computed(() => (chat.data.value as ChatSearchAvailability | undefined)?.readable === true)

type TabKey = 'pages' | 'chat'
const tabs = computed<PageTab<TabKey>[]>(() => [
  { key: 'pages', label: t('search.tabs.pages') },
  ...(chatReadable.value ? [{ key: 'chat' as const, label: t('search.tabs.chat') }] : []),
])
const tab = usePageTabs(tabs, 'pages')
</script>

<template>
  <!-- The shared list chrome, so the title, tabs and body sit on the same rhythm as every other tabbed page. -->
  <PageLayout
    variant="list"
    :title="t('nav.search')"
    :subtitle="tab === 'chat' ? t('search.chat.description') : t('search.sheetDescription')"
  >
    <template v-if="tabs.length > 1" #tabs>
      <PageTabs v-model="tab" :tabs="tabs" :label="t('nav.search')" />
    </template>
    <!-- Each tab keeps its own query and results while the other is open. -->
    <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabs.length > 1 ? tabId(tab) : undefined" class="flex min-h-0 flex-1 flex-col">
      <KeepAlive>
        <ChatSearchWidget v-if="tab === 'chat'" :key="`chat-${q ?? ''}`" :initial-query="q" class="min-h-0 flex-1" />
        <SearchWidget v-else :key="`pages-${q ?? ''}`" :initial-query="q" class="min-h-0 flex-1" />
      </KeepAlive>
    </div>
  </PageLayout>
</template>
