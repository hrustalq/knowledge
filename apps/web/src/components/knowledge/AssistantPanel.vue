<script setup lang="ts">
// Feature 09 (docs/features/09): editor sidebar — review, related docs, suggestions.
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import type {
  AssistantRelatedResponse,
  AssistantReviewResponse,
  AssistantSuggestResponse,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

const props = defineProps<{ title: string; markdown: string }>()
const emit = defineEmits<{ append: [text: string] }>()

const review = ref<AssistantReviewResponse | null>(null)
const related = ref<AssistantRelatedResponse | null>(null)
const suggestion = ref<AssistantSuggestResponse | null>(null)
const instruction = ref('')
const busy = ref<string | null>(null)
const error = ref<string | null>(null)

function severityVariant(s: string): 'destructive' | 'secondary' | 'outline' {
  return s === 'error' ? 'destructive' : s === 'warning' ? 'secondary' : 'outline'
}

// The severity is a machine value; the badge shows its translation, the same
// keys AiCheckPane resolves, so a Russian reader does not see `error`.
function severityLabel(s: string): string {
  return s === 'error' ? 'mr.severityError' : s === 'warning' ? 'mr.severityWarning' : 'mr.severitySuggestion'
}

async function call<T>(kind: string, path: string, body: Record<string, unknown>): Promise<T | null> {
  busy.value = kind
  error.value = null
  try {
    return await apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) })
  } catch (e) {
    error.value = (e as Error).message
    return null
  } finally {
    busy.value = null
  }
}

async function runReview() {
  review.value = await call<AssistantReviewResponse>('review', '/v1/assistant/review', {
    workspaceId: getWorkspaceId(),
    title: props.title,
    markdown: props.markdown,
  })
}

async function runRelated() {
  related.value = await call<AssistantRelatedResponse>('related', '/v1/assistant/related', {
    workspaceId: getWorkspaceId(),
    text: props.markdown || props.title,
    limit: 5,
  })
}

async function runSuggest() {
  if (!instruction.value.trim()) return
  suggestion.value = await call<AssistantSuggestResponse>('suggest', '/v1/assistant/suggest', {
    workspaceId: getWorkspaceId(),
    title: props.title,
    markdown: props.markdown,
    instruction: instruction.value,
  })
}
</script>

<template>
  <div class="space-y-4 rounded-lg border p-4">
    <h2 class="text-sm font-semibold">{{ t('assistant.title') }}</h2>

    <div class="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" :disabled="busy !== null || !markdown.trim()" @click="runReview">
        {{ busy === 'review' ? 'Reviewing…' : 'Review draft' }}
      </Button>
      <Button size="sm" variant="outline" :disabled="busy !== null || !(markdown.trim() || title.trim())" @click="runRelated">
        {{ busy === 'related' ? 'Searching…' : 'Find related docs' }}
      </Button>
    </div>

    <p v-if="error" class="text-xs text-destructive">{{ error }}</p>

    <div v-if="review" class="space-y-2">
      <p v-if="!review.enabled" class="text-xs text-muted-foreground">
        <i18n-t keypath="assistant.reviewDisabled" tag="span" scope="global">
          <template #setting><code>ASSISTANT_PROVIDER=openai-compatible</code></template>
        </i18n-t>
      </p>
      <template v-else>
        <p class="text-xs text-muted-foreground">{{ review.summary }}</p>
        <div v-for="(issue, i) in review.issues" :key="i" class="flex items-start gap-2 text-xs">
          <Badge :variant="severityVariant(issue.severity)" class="shrink-0 text-[10px]">{{ t(severityLabel(issue.severity)) }}</Badge>
          <span>
            <span v-if="issue.section" class="font-medium">{{ issue.section }}: </span>{{ issue.message }}
          </span>
        </div>
        <p v-if="review.issues.length === 0" class="text-xs text-muted-foreground">{{ t('assistant.noIssues') }}</p>
      </template>
    </div>

    <div v-if="related" class="space-y-1.5">
      <p class="text-xs font-medium text-muted-foreground">{{ t('assistant.relatedDocuments') }}</p>
      <p v-if="related.results.length === 0" class="text-xs text-muted-foreground">{{ t('assistant.nothingSimilar') }}</p>
      <div v-for="r in related.results" :key="r.chunkId" class="text-xs">
        <RouterLink :to="`/documents/${r.documentId}`" class="font-medium hover:underline" target="_blank">
          {{ r.title }}
        </RouterLink>
        <span class="text-muted-foreground"> — {{ r.snippet.slice(0, 80) }}…</span>
      </div>
    </div>

    <div class="space-y-2 border-t pt-3">
      <p class="text-xs font-medium text-muted-foreground">{{ t('assistant.suggest') }}</p>
      <form class="flex gap-2" @submit.prevent="runSuggest">
        <Input v-model="instruction" :placeholder="t('assistant.suggestPlaceholder')" class="h-8 text-xs" />
        <Button size="sm" type="submit" :disabled="busy !== null || !instruction.trim()">
          {{ busy === 'suggest' ? '…' : t('assistant.go') }}
        </Button>
      </form>
      <div v-if="suggestion" class="space-y-2">
        <p v-if="!suggestion.enabled" class="text-xs text-muted-foreground">
          <i18n-t keypath="assistant.suggestionsDisabled" tag="span" scope="global">
            <template #setting><code>ASSISTANT_PROVIDER=openai-compatible</code></template>
          </i18n-t>
        </p>
        <template v-else>
          <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{{ suggestion.suggestion }}</pre>
          <Button size="sm" variant="outline" @click="emit('append', suggestion.suggestion)">{{ t('assistant.appendToDraft') }}</Button>
        </template>
      </div>
    </div>
  </div>
</template>
