<script setup lang="ts">
// The AI check, as a pane rather than a card.
//
// Shaped like the assistant chat: findings scroll, the actions dock at the
// bottom and never move. That matters more here than it looks — a review with
// eight findings used to push its own "Re-run" button off the bottom of the
// sidebar, so the control you reach for after reading was the one reading
// took away.
//
// Findings are a dead end unless they can become review feedback, so the dock
// carries a second action that posts them into the discussion as a thread.
import { computed, ref, type Component } from 'vue'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  MessageSquarePlus,
  RefreshCw,
  Sparkles,
} from 'lucide-vue-next'
import type {
  AssistantIssue,
  AssistantReviewResponse,
  DocumentContentResponse,
  MergeRequestInfo,
} from '@knowledge/contracts'
import { api } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  mergeRequest: MergeRequestInfo
  /** Findings can be posted as a review thread only on an open MR you can write to. */
  canComment?: boolean
  /** Posting is in flight in the parent. */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** Findings, composed as markdown, to open as a review thread. */
  comment: [body: string]
  /** Issue counts for the sidebar's tab badge; null once the result is cleared. */
  result: [counts: { issues: number; errors: number } | null]
}>()

const state = ref<'idle' | 'running' | 'done' | 'error'>('idle')
const review = ref<AssistantReviewResponse | null>(null)
const errorMessage = ref('')
const posted = ref(false)

const issues = computed(() => review.value?.issues ?? [])
const errorCount = computed(() => issues.value.filter((i) => i.severity === 'error').length)
const passed = computed(() => state.value === 'done' && review.value?.enabled !== false && issues.value.length === 0)

type Severity = AssistantIssue['severity']

const SEVERITY: Record<Severity, { icon: Component; tone: string; label: string }> = {
  error: { icon: AlertCircle, tone: 'text-red-500', label: 'Error' },
  warning: { icon: AlertTriangle, tone: 'text-amber-500', label: 'Warning' },
  suggestion: { icon: Lightbulb, tone: 'text-sky-500', label: 'Suggestion' },
}

async function run() {
  state.value = 'running'
  errorMessage.value = ''
  posted.value = false
  try {
    const content = (await api.get('/v1/documents/{id}/content', {
      path: { id: props.mergeRequest.documentId },
      query: { revision: props.mergeRequest.sourceHeadRevisionId ?? undefined },
    })) as DocumentContentResponse
    review.value = (await api.post('/v1/assistant/review', {
      body: {
        workspaceId: getWorkspaceId(),
        title: props.mergeRequest.title,
        markdown: content.markdown,
      },
    })) as AssistantReviewResponse
    state.value = 'done'
    emit('result', { issues: issues.value.length, errors: errorCount.value })
  } catch (e) {
    state.value = 'error'
    errorMessage.value = e instanceof Error ? e.message : 'AI check failed'
    emit('result', null)
  }
}

/** Findings → a review comment someone can actually reply to. */
function asMarkdown(): string {
  const lines = [
    `**AI review** — ${issues.value.length} finding${issues.value.length === 1 ? '' : 's'} on \`${props.mergeRequest.sourceBranch}\``,
    '',
    ...issues.value.map((i: AssistantIssue) =>
      `- **${SEVERITY[i.severity].label}** — ${i.message}${i.section ? ` _(${i.section})_` : ''}`,
    ),
  ]
  if (review.value?.summary) lines.push('', review.value.summary)
  return lines.join('\n')
}

function postFindings() {
  if (issues.value.length === 0) return
  emit('comment', asMarkdown())
  posted.value = true
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="quiet-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <!-- Status reads like a check on a pipeline: one line, one colour. -->
      <p v-if="state === 'idle'" class="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <Sparkles class="mt-0.5 size-3.5 shrink-0" />
        <span>
          Reads the source branch as a reviewer would — structure, gaps, contradictions — and lists what it would
          raise. Nothing is changed.
        </span>
      </p>

      <p v-else-if="state === 'running'" class="flex items-center gap-2 text-xs text-muted-foreground">
        <span class="size-1.5 animate-pulse rounded-full bg-amber-500" />
        Reviewing&nbsp;<span class="font-mono">{{ mergeRequest.sourceBranch }}</span>…
      </p>

      <p v-else-if="state === 'error'" class="flex items-start gap-2 text-xs leading-5 text-destructive">
        <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
        {{ errorMessage }}
      </p>

      <template v-else-if="review">
        <p v-if="!review.enabled" class="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          AI review is not configured on this server (<span class="font-mono">ASSISTANT_PROVIDER=none</span>).
        </p>

        <p v-else-if="passed" class="flex items-center gap-2 text-xs font-medium text-emerald-600">
          <CheckCircle2 class="size-4" /> Passed — nothing to raise
        </p>

        <template v-else>
          <p
            class="text-xs font-medium"
            :class="errorCount > 0 ? 'text-red-600' : 'text-amber-600'"
          >
            {{ issues.length }} finding{{ issues.length === 1 ? '' : 's' }}<template v-if="errorCount > 0">,
            {{ errorCount }} to fix</template>
          </p>

          <ul class="mt-2.5 space-y-2.5">
            <li v-for="(issue, i) in issues" :key="i" class="flex gap-2">
              <component
                :is="SEVERITY[issue.severity].icon"
                class="mt-0.5 size-3.5 shrink-0"
                :class="SEVERITY[issue.severity].tone"
                :aria-label="SEVERITY[issue.severity].label"
              />
              <p class="min-w-0 text-xs leading-5">
                {{ issue.message }}
                <span v-if="issue.section" class="text-muted-foreground">— {{ issue.section }}</span>
              </p>
            </li>
          </ul>

          <p v-if="review.summary" class="mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground">
            {{ review.summary }}
          </p>
        </template>
      </template>
    </div>

    <!-- Dock: the actions stay put while the findings scroll past them. -->
    <div class="shrink-0 border-t bg-background px-3 py-2.5">
      <div class="flex items-center gap-1.5">
        <Button
          :variant="state === 'idle' ? 'default' : 'outline'"
          size="sm"
          class="flex-1"
          :disabled="state === 'running'"
          @click="run"
        >
          <RefreshCw v-if="state !== 'idle'" class="size-3.5" :class="state === 'running' ? 'animate-spin' : ''" />
          <Sparkles v-else class="size-3.5" />
          {{ state === 'running' ? 'Reviewing…' : state === 'idle' ? 'Run review' : 'Re-run' }}
        </Button>

        <Button
          v-if="canComment && issues.length > 0"
          variant="outline"
          size="sm"
          :disabled="busy || posted"
          :title="posted ? 'Already posted to the discussion' : 'Post these findings as a review thread'"
          @click="postFindings"
        >
          <MessageSquarePlus class="size-3.5" />
          {{ posted ? 'Posted' : 'Post' }}
        </Button>
      </div>
    </div>
  </div>
</template>
