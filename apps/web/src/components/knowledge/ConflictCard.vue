<script setup lang="ts">
/**
 * One contradiction between two pages (#81): the two passages that disagree,
 * why, and the three things an editor can do — propose a fix (a merge request
 * on the first page, the arbiter's finding path), resolve it, or dismiss it.
 *
 * One card for the page rail and the /conflicts page. In the rail it stacks
 * and leads with the *other* page, because the reader is already on this one;
 * on the page it lays the two quotes side by side, each under its title.
 *
 * Quotes take the prose blockquote's hairline rule, not a coloured border:
 * this is evidence to read, not an alarm. Status is an outline badge; none of
 * the indexing lifecycle's signal colours are borrowed.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { GitMerge, GitPullRequest } from 'lucide-vue-next'
import type { ConflictSide, KnowledgeConflictDto } from '@knowledge/contracts'
import { api } from '@/api/client'
import { errorMessage, errorReason } from '@/api/errors'
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import WorkItemChips from './WorkItemChips.vue'

const props = withDefaults(
  defineProps<{
    conflict: KnowledgeConflictDto
    /** The page the reader is on, in the rail: its side is "this page". */
    currentDocumentId?: string | null
    layout?: 'stacked' | 'side-by-side'
  }>(),
  { currentDocumentId: null, layout: 'side-by-side' },
)

const { t } = useI18n()
const auth = useAuthStore()
const queryClient = useQueryClient()
const busy = ref<'propose' | 'resolved' | 'dismissed' | null>(null)

/** In the rail, this page first; elsewhere, as found. A doc↔code conflict has one page side. */
const sides = computed<ConflictSide[]>(() => {
  const { a, b } = props.conflict
  if (!b) return [a]
  return props.currentDocumentId && b.documentId === props.currentDocumentId ? [b, a] : [a, b]
})
const code = computed(() => props.conflict.codeRef)
const isOpen = computed(() => props.conflict.status === 'open')

function refresh() {
  void queryClient.invalidateQueries({ queryKey: ['/v1/conflicts'] })
}

async function close(status: 'resolved' | 'dismissed') {
  if (busy.value) return
  busy.value = status
  try {
    await api.post(status === 'resolved' ? '/v1/conflicts/{id}/resolve' : '/v1/conflicts/{id}/dismiss', {
      path: { id: props.conflict.id },
      body: {},
    })
    toast.success(t(`conflicts.toast.${status}`))
    refresh()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}

async function propose() {
  if (busy.value) return
  busy.value = 'propose'
  try {
    const res = await api.post('/v1/conflicts/{id}/propose', { path: { id: props.conflict.id } })
    toast.success(t('conflicts.toast.proposed', { title: res.documentTitle }))
    refresh()
  } catch (e) {
    // Somebody proposed it a moment ago: the refetch shows their merge request.
    if (errorReason(e) === 'already-proposed') refresh()
    else toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <!-- Stacked, it lives inside a rail widget that is already a card: no
       second border, the rail draws the dividers. -->
  <article class="text-sm" :class="[layout === 'stacked' ? '' : 'rounded-lg border bg-card p-3', isOpen ? '' : 'opacity-80']">
    <div
      class="grid gap-3"
      :class="layout === 'side-by-side' ? 'sm:grid-cols-2' : ''"
    >
      <figure v-for="(side, i) in sides" :key="i" class="min-w-0 space-y-1">
        <figcaption class="truncate text-xs text-muted-foreground">
          <template v-if="currentDocumentId && side.documentId === currentDocumentId">{{ t('conflicts.thisPage') }}</template>
          <template v-else>
            <RouterLink :to="`/documents/${side.documentId}`" class="font-medium text-foreground underline-offset-2 hover:underline">{{ side.title }}</RouterLink>
            <span v-if="currentDocumentId" class="ml-1">{{ t('conflicts.says') }}</span>
          </template>
        </figcaption>
        <blockquote class="kn-measure border-l border-muted-foreground/45 pl-2.5 text-ui leading-relaxed break-words text-foreground">
          {{ side.quote }}
        </blockquote>
      </figure>
      <!-- #81 phase 6: the code side is a change, not a passage — the pull
           request, the head the sentinel judged, and the files it touches.
           No favicon: a reader's browser never asks a third-party host. -->
      <figure v-if="code" class="min-w-0 space-y-1">
        <figcaption class="truncate text-xs text-muted-foreground">
          <a :href="code.pullRequestUrl" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline">
            <GitPullRequest class="size-3" aria-hidden="true" />{{ code.repository }} #{{ code.pullRequestNumber }}
          </a>
          <span class="ml-1 font-mono">{{ code.headSha.slice(0, 7) }}</span>
          <span class="ml-1">{{ t('conflicts.changes') }}</span>
        </figcaption>
        <ul class="border-l border-muted-foreground/45 pl-2.5 font-mono text-xs leading-relaxed break-all text-foreground">
          <li v-for="path in code.paths.slice(0, 6)" :key="path">{{ path }}</li>
          <li v-if="code.paths.length > 6" class="font-sans text-muted-foreground">{{ t('conflicts.morePaths', { n: code.paths.length - 6 }) }}</li>
        </ul>
      </figure>
    </div>

    <p class="kn-measure mt-2.5 text-xs leading-relaxed break-words text-muted-foreground">{{ conflict.explanation }}</p>

    <p class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
      <Badge v-if="!isOpen" variant="outline" class="text-caption font-normal">{{ t(`conflicts.status.${conflict.status}`) }}</Badge>
      <span :title="formatDateTime(conflict.detectedAt)">{{ t('conflicts.found', { when: formatRelative(conflict.detectedAt) }) }}</span>
      <span v-if="conflict.kind === 'doc-doc'">· {{ t('conflicts.confidence', { value: formatNumber(Math.round(conflict.confidence * 100)) }) }}</span>
      <RouterLink
        v-if="conflict.mergeRequestId"
        :to="`/merge-requests/${conflict.mergeRequestId}`"
        class="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
      >
        <GitMerge class="size-3" aria-hidden="true" />
        {{ t('conflicts.openMergeRequest') }}
      </RouterLink>
      <span v-if="conflict.resolution" class="basis-full italic">“{{ conflict.resolution }}”</span>
    </p>

    <div v-if="isOpen && auth.canEdit" class="mt-2.5 flex flex-wrap gap-1.5">
      <Button
        v-if="!conflict.mergeRequestId && conflict.agentRunId"
        variant="outline"
        size="sm"
        class="h-7 text-xs"
        :disabled="!!busy"
        @click="propose"
      >
        {{ busy === 'propose' ? t('conflicts.proposing') : t('conflicts.propose') }}
      </Button>
      <Button variant="outline" size="sm" class="h-7 text-xs" :disabled="!!busy" @click="close('resolved')">
        {{ t('conflicts.resolve') }}
      </Button>
      <Button variant="ghost" size="sm" class="h-7 text-xs" :disabled="!!busy" @click="close('dismissed')">
        {{ t('conflicts.dismiss') }}
      </Button>
    </div>
    <!-- Handed off while open; a closed one still shows the ticket it had. -->
    <WorkItemChips source-kind="conflict" :source-id="conflict.id" :can-handoff="isOpen && auth.canEdit" class="mt-2" />
  </article>
</template>
