<script setup lang="ts">
// GitLab-pipeline-style AI check: runs the assistant review over the MR's
// source-head content on demand and reports pass / issues in the sidebar.
import { computed, ref } from 'vue'
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Lightbulb, Sparkles } from 'lucide-vue-next'
import type { AssistantReviewResponse, DocumentContentResponse, MergeRequestInfo } from '@knowledge/contracts'
import { api } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'

const props = defineProps<{ mergeRequest: MergeRequestInfo }>()

const state = ref<'idle' | 'running' | 'done' | 'error'>('idle')
const result = ref<AssistantReviewResponse | null>(null)
const errorMessage = ref('')
const expanded = ref(false)

const errorCount = computed(() => result.value?.issues.filter((i) => i.severity === 'error').length ?? 0)

async function run() {
  state.value = 'running'
  errorMessage.value = ''
  try {
    const content = (await api.get('/v1/documents/{id}/content', {
      path: { id: props.mergeRequest.documentId },
      query: { revision: props.mergeRequest.sourceHeadRevisionId ?? undefined },
    })) as DocumentContentResponse
    result.value = (await api.post('/v1/assistant/review', {
      body: {
        workspaceId: getWorkspaceId(),
        title: props.mergeRequest.title,
        markdown: content.markdown,
      },
    })) as AssistantReviewResponse
    state.value = 'done'
    expanded.value = (result.value?.issues.length ?? 0) > 0
  } catch (e) {
    state.value = 'error'
    errorMessage.value = e instanceof Error ? e.message : 'AI check failed'
  }
}

function severityIcon(severity: 'error' | 'warning' | 'suggestion') {
  if (severity === 'error') return { icon: AlertCircle, class: 'text-red-500' }
  if (severity === 'warning') return { icon: AlertTriangle, class: 'text-amber-500' }
  return { icon: Lightbulb, class: 'text-sky-500' }
}
</script>

<template>
  <div class="rounded-lg border bg-card p-3">
    <div class="flex items-center gap-2">
      <Sparkles class="size-4 text-muted-foreground" />
      <p class="text-xs font-medium">AI check</p>
      <Button
        variant="outline"
        size="xs"
        class="ml-auto"
        :disabled="state === 'running'"
        @click="run"
      >
        {{ state === 'running' ? 'Checking…' : state === 'done' || state === 'error' ? 'Re-run' : 'Run' }}
      </Button>
    </div>

    <div class="mt-2 text-xs">
      <p v-if="state === 'idle'" class="text-muted-foreground">
        Review the source content with the AI assistant.
      </p>
      <p v-else-if="state === 'running'" class="flex items-center gap-1.5 text-muted-foreground">
        <span class="size-1.5 animate-pulse rounded-full bg-amber-500" /> Reviewing source content…
      </p>
      <p v-else-if="state === 'error'" class="text-destructive">{{ errorMessage }}</p>
      <template v-else-if="result">
        <p v-if="!result.enabled" class="text-muted-foreground">
          AI review is not configured (ASSISTANT_PROVIDER=none).
        </p>
        <template v-else>
          <p v-if="result.issues.length === 0" class="flex items-center gap-1.5 text-emerald-600">
            <CheckCircle2 class="size-3.5" /> Passed — no issues found
          </p>
          <div v-else>
            <button
              class="flex items-center gap-1.5 hover:text-foreground"
              :class="errorCount > 0 ? 'text-red-600' : 'text-amber-600'"
              @click="expanded = !expanded"
            >
              <component :is="expanded ? ChevronDown : ChevronRight" class="size-3.5" />
              {{ result.issues.length }} issue{{ result.issues.length === 1 ? '' : 's' }}
              <template v-if="errorCount > 0"> ({{ errorCount }} error{{ errorCount === 1 ? '' : 's' }})</template>
            </button>
            <ul v-if="expanded" class="mt-2 space-y-2">
              <li v-for="(issue, i) in result.issues" :key="i" class="flex gap-1.5">
                <component
                  :is="severityIcon(issue.severity).icon"
                  class="mt-0.5 size-3.5 shrink-0"
                  :class="severityIcon(issue.severity).class"
                />
                <span>
                  {{ issue.message }}
                  <span v-if="issue.section" class="text-muted-foreground">— {{ issue.section }}</span>
                </span>
              </li>
            </ul>
            <p v-if="result.summary && expanded" class="mt-2 border-t pt-2 text-muted-foreground">
              {{ result.summary }}
            </p>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
