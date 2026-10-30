<script setup lang="ts">
// The conflict view (#636): every conflicting page the reader may open, as the
// 3-way merge with git's markers, resolved in place and sent as "Update
// branch" — a merge of the target into the source, never a rebase. A
// resolution is pinned to the target head it was made against, so a target
// that moved meanwhile reloads the view instead of landing a stale one.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQueryClient } from '@tanstack/vue-query'
import { Check, GitMerge } from 'lucide-vue-next'
import type { MergeGateConflictDetails, MergeRequestConflictPage } from '@knowledge/contracts'
import { isApiRequestError, useApiMutation } from '@/shared/api/queries'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Textarea } from '@/shared/ui/textarea'

const props = defineProps<{
  mergeRequestId: string
  pages: MergeRequestConflictPage[]
  hiddenPages: number
  targetBranch: string
  sourceBranch: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ updated: [] }>()

const { t } = useI18n()
const queryClient = useQueryClient()

/** The edited body per page, reset whenever that page's heads change. */
const texts = ref<Record<string, string>>({})
const seen = new Map<string, string>()
watch(
  () => props.pages,
  (pages) => {
    for (const p of pages) {
      const key = `${p.targetHeadRevisionId}:${p.sourceHeadRevisionId}`
      if (seen.get(p.documentId) === key) continue
      seen.set(p.documentId, key)
      texts.value[p.documentId] = p.text
    }
  },
  { immediate: true },
)

/** Conflict blocks still open in a body: its opening markers. */
const left = (text: string | undefined) => (text?.match(/^<{7} /gm) ?? []).length
const remaining = computed(() => props.pages.reduce((n, p) => n + left(texts.value[p.documentId]), 0))

const conflictsKey = () => ['/v1/merge-requests/{id}/conflicts', { id: props.mergeRequestId }]
const update = useApiMutation('post', '/v1/merge-requests/{id}/update-branch', {
  invalidates: () => [
    conflictsKey(),
    ['/v1/merge-requests/{id}', { id: props.mergeRequestId }],
    ['/v1/merge-requests/{id}/diff'],
    ['/v1/merge-requests/{id}/checks'],
  ],
})

function submit() {
  update.mutate(
    {
      path: { id: props.mergeRequestId },
      body: {
        resolutions: props.pages.map((p) => ({
          documentId: p.documentId,
          targetHeadRevisionId: p.targetHeadRevisionId,
          content: texts.value[p.documentId] ?? '',
        })),
      },
    },
    {
      onSuccess: () => {
        toast.success(t('mr.branch.updated'))
        open.value = false
        emit('updated')
      },
      onError: (e) => {
        const reason = isApiRequestError(e) ? (e.payload.details as Partial<MergeGateConflictDetails> | undefined)?.reason : undefined
        if (reason === 'diverged' || reason === 'conflict') {
          toast.error(t('mr.branch.stale'))
          void queryClient.invalidateQueries({ queryKey: conflictsKey() })
        } else toast.error(e.message)
      },
    },
  )
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[90dvh] flex-col gap-4 sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>{{ t('mr.branch.resolveTitle') }}</DialogTitle>
        <DialogDescription>
          {{ t('mr.branch.resolveDesc', { target: targetBranch, source: sourceBranch }) }}
        </DialogDescription>
      </DialogHeader>

      <div class="-mx-1 min-h-0 flex-1 space-y-5 overflow-y-auto px-1">
        <section v-for="p in pages" :key="p.documentId" class="space-y-2">
          <div class="flex items-baseline gap-3">
            <h3 class="min-w-0 flex-1 truncate text-sm font-medium" :title="p.title">{{ p.title }}</h3>
            <span
              class="flex shrink-0 items-center gap-1 text-xs tabular-nums"
              :class="left(texts[p.documentId]) > 0 ? 'text-panel-caution-ink' : 'text-panel-tip-ink'"
              aria-live="polite"
            >
              <template v-if="left(texts[p.documentId]) > 0">
                {{ t('mr.branch.left', { n: left(texts[p.documentId]) }, left(texts[p.documentId])) }}
              </template>
              <template v-else><Check class="size-3.5" aria-hidden="true" /> {{ t('mr.branch.resolved') }}</template>
            </span>
          </div>
          <Textarea
            v-model="texts[p.documentId]"
            :aria-label="t('mr.branch.pageLabel', { title: p.title })"
            spellcheck="false"
            class="min-h-64 resize-y font-mono text-xs leading-5"
          />
        </section>
        <p v-if="hiddenPages > 0" class="kn-callout-warning text-sm">{{ t('mr.branch.hiddenBlock') }}</p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button :disabled="remaining > 0 || hiddenPages > 0 || pages.length === 0 || update.isPending.value" @click="submit">
          <GitMerge class="size-3.5" /> {{ t('mr.branch.update') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
