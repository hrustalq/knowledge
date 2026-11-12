<script setup lang="ts">
/**
 * Promote a memory to a page (#994): it becomes a capture, so a merge request
 * someone reviews — never a page written straight away. The memory stays in
 * the bank. The bank it came from is set by the server as the capture's
 * origin; what this asks is only where the page goes and what it is called.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { MEMORY_PROMOTE_KINDS, type CaptureResult, type MemoryPromoteKind, type MemoryUnitSummary } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@knowledge/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@knowledge/ui/dialog'
import { Input } from '@knowledge/ui/input'
import { Label } from '@knowledge/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'

const { t } = useI18n()
const props = defineProps<{ open: boolean; bankId: string; memory: MemoryUnitSummary; projectId: string | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; promoted: [CaptureResult] }>()
const projects = useProjectsStore()
const router = useRouter()

const projectId = ref('')
const title = ref('')
const kind = ref<MemoryPromoteKind>('howto')
const working = ref(false)
const failed = ref<string | null>(null)

/** A first line, cut at a word, as the title to start from. */
const titleFrom = (text: string) => {
  const line = text.split('\n')[0]!.trim()
  return line.length <= 80 ? line : `${line.slice(0, 80).replace(/\s+\S*$/, '')}…`
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (!projects.loaded) void projects.fetchList().catch(() => undefined)
    // The bank's own project first: a project-bound memory most likely belongs there.
    projectId.value = props.projectId ?? projects.items[0]?.projectId ?? ''
    title.value = titleFrom(props.memory.text)
    kind.value = 'howto'
    failed.value = null
  },
  { immediate: true },
)
watch(
  () => projects.items,
  (items) => {
    if (!projectId.value && items.length) projectId.value = items[0]!.projectId
  },
)

const ready = computed(() => !!projectId.value && !!title.value.trim() && !working.value)

async function promote() {
  if (!ready.value) return
  working.value = true
  failed.value = null
  try {
    const res = await api.post('/v1/memory/banks/{id}/memories/{memoryId}/promote', {
      path: { id: props.bankId, memoryId: props.memory.id },
      body: { projectId: projectId.value, title: title.value.trim(), kind: kind.value },
    })
    emit('promoted', res)
    emit('update:open', false)
    toast.success(res.mergeRequestId ? t('memory.promote.proposed') : t('memory.promote.duplicate'), {
      action: res.mergeRequestId ? { label: t('memory.promote.open'), onClick: () => void router.push(`/merge-requests/${res.mergeRequestId}`) } : undefined,
    })
  } catch (e) {
    failed.value = errorMessage(e, t)
  } finally {
    working.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('memory.promote.title') }}</DialogTitle>
        <DialogDescription>{{ t('memory.promote.body') }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="promote">
        <blockquote class="max-h-32 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 text-sm break-words whitespace-pre-wrap" tabindex="0">{{ memory.text }}</blockquote>
        <div class="space-y-1.5">
          <Label for="promote-title">{{ t('memory.promote.pageTitle') }}</Label>
          <Input id="promote-title" v-model="title" maxlength="300" autocomplete="off" />
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="min-w-0 space-y-1.5">
            <Label for="promote-project">{{ t('memory.promote.project') }}</Label>
            <Select v-model="projectId">
              <SelectTrigger id="promote-project" class="w-full"><SelectValue :placeholder="t('memory.promote.pickProject')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="min-w-0 space-y-1.5">
            <Label for="promote-kind">{{ t('memory.promote.kind') }}</Label>
            <Select v-model="kind">
              <SelectTrigger id="promote-kind" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="k in MEMORY_PROMOTE_KINDS" :key="k" :value="k">{{ t(`memory.promote.kinds.${k}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">
          {{ t('memory.promote.review') }}
          <RouterLink to="/captures" class="text-primary underline-offset-4 hover:underline">{{ t('memory.promote.inbox') }}</RouterLink>
        </p>
        <p v-if="failed" class="text-sm text-destructive" role="alert">{{ failed }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="working" @click="emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="!ready">{{ working ? t('memory.promote.working') : t('memory.promote.submit') }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
