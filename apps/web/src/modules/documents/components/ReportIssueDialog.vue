<script setup lang="ts">
/**
 * "Report a problem" with a page (docs/features/38, phase 3).
 *
 * What is wrong, in the reader's words, with the passage they dispute. An
 * editor may also paste the corrected body: that opens a draft merge request
 * at once, in their name, rather than waiting for the sentinel. A viewer's
 * suggestion is still taken — it reaches the sentinel as evidence — but the
 * field says so, because a control that silently does less than it looks is
 * the thing the settings pages are built to avoid.
 *
 * The outcome is told back honestly: folded into an open report, being
 * checked, proposed as a merge request, or waiting for a person.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { KnowledgeIssueKind, ReportKnowledgeIssueResponse } from '@knowledge/contracts'
import { KNOWLEDGE_ISSUE_KINDS } from '@knowledge/contracts'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { useAuthStore } from '@/stores/auth'
import { useFeedbackStore } from '@/entities/assistant'

const props = defineProps<{
  documentId: string
  title: string
  /** The revision on screen, so the report says what the reporter read. */
  revisionId?: string | null
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ reported: [ReportKnowledgeIssueResponse] }>()

const { t } = useI18n()
const auth = useAuthStore()
const feedback = useFeedbackStore()

const kind = ref<KnowledgeIssueKind>('wrong')
const detail = ref('')
const quote = ref('')
const url = ref('')
const suggestion = ref('')
const sending = ref(false)
const error = ref<string | null>(null)

watch(open, (isOpen) => {
  if (!isOpen) return
  kind.value = 'wrong'
  detail.value = ''
  quote.value = ''
  url.value = ''
  suggestion.value = ''
  error.value = null
})

const canSend = computed(() => detail.value.trim().length > 0 && !sending.value)

async function submit() {
  if (!canSend.value) return
  sending.value = true
  error.value = null
  try {
    const evidence = [
      ...(quote.value.trim() ? [{ quote: quote.value.trim() }] : []),
      ...(url.value.trim() ? [{ url: url.value.trim() }] : []),
    ]
    const res = await feedback.reportIssue({
      workspaceId: getWorkspaceId(),
      documentId: props.documentId,
      ...(props.revisionId ? { revisionId: props.revisionId } : {}),
      kind: kind.value,
      detail: detail.value.trim(),
      ...(evidence.length ? { evidence } : {}),
      ...(suggestion.value.trim() ? { suggestedMarkdown: suggestion.value.trim() } : {}),
      surface: 'web',
    })
    open.value = false
    emit('reported', res)
    toast.success(
      res.deduplicated
        ? t('knowledgeIssue.toast.deduplicated', { n: res.issue.reportCount })
        : t(`knowledgeIssue.toast.${res.issue.status}`),
    )
  } catch (e) {
    error.value = errorMessage(e, t)
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('knowledgeIssue.reportTitle', { title }) }}</DialogTitle>
        <DialogDescription>{{ t('knowledgeIssue.reportDescription') }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-3 text-sm">
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">{{ t('knowledgeIssue.kindLabel') }}</span>
          <Select v-model="kind">
            <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="k in KNOWLEDGE_ISSUE_KINDS" :key="k" :value="k">{{ t(`knowledgeIssue.kind.${k}`) }}</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">{{ t('knowledgeIssue.detail') }}</span>
          <Textarea v-model="detail" rows="4" maxlength="4000" :placeholder="t('knowledgeIssue.detailPlaceholder')" />
        </label>

        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">{{ t('knowledgeIssue.quote') }}</span>
          <Textarea v-model="quote" rows="2" maxlength="2000" :placeholder="t('knowledgeIssue.quotePlaceholder')" />
        </label>

        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">{{ t('knowledgeIssue.url') }}</span>
          <input
            v-model="url"
            type="url"
            maxlength="2000"
            :placeholder="t('knowledgeIssue.urlPlaceholder')"
            class="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring"
          />
        </label>

        <!-- The same field for everyone, with the truth about what it does:
             an editor's correction ships as a merge request now, a viewer's is
             evidence for the check. -->
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">{{ t('knowledgeIssue.suggestion') }}</span>
          <Textarea v-model="suggestion" rows="5" maxlength="200000" class="font-mono text-xs" :placeholder="t('knowledgeIssue.suggestionPlaceholder')" />
          <span class="block text-xs text-muted-foreground">
            {{ auth.canEdit ? t('knowledgeIssue.suggestionEditorHint') : t('knowledgeIssue.suggestionViewerHint') }}
          </span>
        </label>

        <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button size="sm" :disabled="!canSend" @click="submit">{{ t('knowledgeIssue.send') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
