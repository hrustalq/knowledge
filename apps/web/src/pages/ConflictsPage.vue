<script setup lang="ts">
/**
 * /conflicts (#81): every contradiction the arbiter found between pages the
 * reader may open, by status. Open is where the work is, so it is where the
 * page lands; the other tabs are the record of what was decided.
 *
 * Each conflict lays its two passages side by side under their pages — the
 * reader compares them, which is the whole task. The arbiter writes these;
 * when none exist the empty state says how to run it, not that all is well.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { CONFLICT_STATUSES, type ConflictStatus, type ListConflictsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { PageLayout, PageState, PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/components/layout/page'
import ConflictCard from '@/components/knowledge/ConflictCard.vue'

const { t } = useI18n()

const tabs = computed<PageTab<ConflictStatus>[]>(() => CONFLICT_STATUSES.map((key) => ({ key, label: t(`conflicts.status.${key}`) })))
const tab = usePageTabs(tabs, 'open')

const query = useQuery(
  computed(() => apiQueryOptions('/v1/conflicts', { query: { workspaceId: getWorkspaceId(), status: tab.value } })),
)
const conflicts = computed(() => (query.data.value as ListConflictsResponse | undefined)?.conflicts ?? [])
</script>

<template>
  <PageLayout variant="list" :title="t('conflicts.title')" :subtitle="t('conflicts.subtitle')">
    <template #tabs>
      <PageTabs v-model="tab" :tabs="tabs" :label="t('filters.status')" />
    </template>

    <!-- Capped: two passages read side by side, and a 1500px line is not read. -->
    <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)" class="flex w-full max-w-5xl min-w-0 flex-col gap-3">
      <PageState v-if="query.isPending.value" state="loading" :rows="3" row-class="h-36" />
      <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />
      <div v-else-if="!conflicts.length" class="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        <p class="font-medium text-foreground">{{ t(`conflicts.empty.${tab}`) }}</p>
        <p v-if="tab === 'open'" class="mx-auto mt-1 max-w-md">
          {{ t('conflicts.empty.hint') }}
          <RouterLink to="/settings/ai/agents" class="underline underline-offset-2 hover:text-foreground">{{ t('conflicts.empty.hintLink') }}</RouterLink>
        </p>
      </div>
      <template v-else>
        <ConflictCard v-for="c in conflicts" :key="c.id" :conflict="c" />
      </template>
    </div>
  </PageLayout>
</template>
