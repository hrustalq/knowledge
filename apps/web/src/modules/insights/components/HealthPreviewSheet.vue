<script setup lang="ts">
/**
 * A page beside the table (docs/features/40): enough to decide what to do
 * with it without leaving the dashboard.
 *
 * The sheet shows the page's verification widget — the very `VerificationBar`
 * the page rail draws, so verifying from here is the same act as verifying
 * there — and the rendered body under it. Both come from the page's own
 * routes (`GET :id`, `GET :id/content`), fetched only while the sheet is open.
 *
 * A write made in the widget refetches the dashboard: the row the sheet was
 * opened from may have just left the preset it was listed under.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ExternalLink } from 'lucide-vue-next'
import type { DocumentContentResponse, DocumentDetailResponse, KnowledgeHealthRow } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { Button } from '@/shared/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/shared/ui/sheet'
import { PageState } from '@/shared/layout'
import { MarkdownView } from '@/entities/document'
import { VerificationBar } from '@/entities/document'

const props = defineProps<{ row: KnowledgeHealthRow | null }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const queryClient = useQueryClient()

const id = computed(() => props.row?.documentId ?? '')
const open = computed(() => props.row !== null)

const detailOptions = computed(() => ({
  ...apiQueryOptions('/v1/documents/{id}', { path: { id: id.value } }),
  enabled: open.value,
}))
const detailQuery = useQuery(detailOptions)
const detail = computed(() => detailQuery.data.value as DocumentDetailResponse | undefined)

const contentQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/documents/{id}/content', { path: { id: id.value } }),
    enabled: open.value,
  })),
)
const content = computed(() => contentQuery.data.value as DocumentContentResponse | undefined)

/** The dashboard's list and counts: whatever the widget just did, a row may have moved. */
function refreshDashboard() {
  void queryClient.invalidateQueries({ queryKey: ['/v1/knowledge-health'] })
  void queryClient.invalidateQueries({ queryKey: ['/v1/knowledge-health/summary'] })
}
function onDetail(next: DocumentDetailResponse) {
  queryClient.setQueryData(detailOptions.value.queryKey, next)
  refreshDashboard()
}
function onReload() {
  void queryClient.invalidateQueries({ queryKey: detailOptions.value.queryKey })
  refreshDashboard()
}
</script>

<template>
  <Sheet :open="open" @update:open="(v: boolean) => !v && emit('close')">
    <SheetContent side="right" class="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
      <SheetHeader class="space-y-1 border-b px-5 py-4 pr-12">
        <SheetTitle class="truncate text-base">{{ row?.title }}</SheetTitle>
        <SheetDescription class="truncate text-xs">
          {{ row?.breadcrumb || t('health.previewRoot') }}
        </SheetDescription>
        <Button variant="outline" size="xs" class="w-fit" as-child>
          <RouterLink :to="`/documents/${id}`">
            <ExternalLink class="size-3" />
            {{ t('health.openPage') }}
          </RouterLink>
        </Button>
      </SheetHeader>

      <div class="quiet-scroll min-h-0 flex-1 overflow-y-auto">
        <section class="border-b px-5 py-3">
          <h3 class="mb-2 text-xs font-medium text-muted-foreground">{{ t('verification.title') }}</h3>
          <PageState v-if="detailQuery.isPending.value" state="loading" :rows="2" row-class="h-5" />
          <PageState v-else-if="detailQuery.isError.value" state="error" :error="detailQuery.error.value" />
          <VerificationBar v-else-if="detail" :detail="detail" @update:detail="onDetail" @reload="onReload" />
        </section>

        <section class="px-5 py-4">
          <PageState v-if="contentQuery.isPending.value" state="loading" :rows="6" />
          <PageState v-else-if="contentQuery.isError.value" state="error" :error="contentQuery.error.value" />
          <MarkdownView v-else-if="content" :markdown="content.markdown" />
        </section>
      </div>
    </SheetContent>
  </Sheet>
</template>
