<script setup lang="ts">
/**
 * A page beside whatever you were looking at: enough to decide what to do with
 * it without leaving. The health dashboard (docs/features/40) opens it from a
 * row, every graph (docs/features/06) from a node (#1254).
 *
 * The sheet shows the page's verification widget — the very `VerificationBar`
 * the page rail draws, so verifying from here is the same act as verifying
 * there — and the rendered body under it. All three reads go through the page's
 * own routes, under the reader's own access, and only while the sheet is open:
 * a page the reader may not see answers 403 and is never drawn. The detail and
 * content keys are the page view's own, so "Open page" lands on a warm cache.
 *
 * `modal: false` is the graph's mode: no overlay, and a click outside does not
 * dismiss, so the next node swaps the page instead of closing the sheet. The
 * graph closes it itself on a click on empty canvas; Esc closes it anywhere.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ExternalLink } from 'lucide-vue-next'
import type { DocumentAncestorsResponse, DocumentContentResponse, DocumentDetailResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { Button } from '@knowledge/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@knowledge/ui/sheet'
import { PageState } from '@knowledge/ui/layout'
import { documentContentQuery, documentDetailQuery } from '../model/page-queries'
import MarkdownView from './MarkdownView.vue'
import VerificationBar from './VerificationBar.vue'

const props = withDefaults(
  defineProps<{
    documentId: string | null
    /** Shown until the detail arrives, so the header never flashes empty. */
    title?: string
    modal?: boolean
  }>(),
  { title: '', modal: true },
)
const emit = defineEmits<{
  close: []
  /** The widget wrote: a list the sheet was opened from may have changed. */
  changed: []
}>()

const { t } = useI18n()
const queryClient = useQueryClient()

const id = computed(() => props.documentId ?? '')
const open = computed(() => props.documentId !== null)

/** Below `sm` there is no room beside the content: the sheet rises from the bottom. */
const narrow = useMediaQuery('(width < 40rem)')

const detailOptions = computed(() => ({ ...documentDetailQuery(id.value), enabled: open.value }))
const detailQuery = useQuery(detailOptions)
const detail = computed(() => detailQuery.data.value as DocumentDetailResponse | undefined)

const contentQuery = useQuery(computed(() => ({ ...documentContentQuery(id.value, null), enabled: open.value })))
const content = computed(() => contentQuery.data.value as DocumentContentResponse | undefined)

const ancestorsQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/documents/{id}/ancestors', { path: { id: id.value } }),
    enabled: open.value,
  })),
)
const breadcrumb = computed(() => {
  const res = ancestorsQuery.data.value as DocumentAncestorsResponse | undefined
  if (!res) return ''
  if (!res.ancestors.length) return t('documents.previewRoot')
  return res.ancestors.map((a) => (a.hidden ? t('access.restrictedPage') : a.title)).join(' / ')
})

const heading = computed(() => detail.value?.document.title ?? props.title)

function onDetail(next: DocumentDetailResponse) {
  queryClient.setQueryData(detailOptions.value.queryKey, next)
  emit('changed')
}
function onReload() {
  void queryClient.invalidateQueries({ queryKey: detailOptions.value.queryKey })
  emit('changed')
}
</script>

<template>
  <Sheet :open="open" :modal="modal" @update:open="(v: boolean) => !v && emit('close')">
    <SheetContent
      :side="narrow ? 'bottom' : 'right'"
      class="flex flex-col gap-0 p-0"
      :class="narrow ? 'max-h-[85dvh] rounded-t-xl' : 'w-full sm:max-w-xl'"
      @interact-outside="(e: Event) => !modal && e.preventDefault()"
    >
      <SheetHeader class="space-y-1 border-b px-5 py-4 pr-12">
        <SheetTitle class="truncate text-base">{{ heading }}</SheetTitle>
        <SheetDescription class="truncate text-xs">{{ breadcrumb || ' ' }}</SheetDescription>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="xs" as-child>
            <RouterLink :to="`/documents/${id}`">
              <ExternalLink class="size-3" />
              {{ t('documents.previewOpen') }}
            </RouterLink>
          </Button>
          <slot name="actions" />
        </div>
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
