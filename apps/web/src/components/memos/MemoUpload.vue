<script setup lang="ts">
/**
 * One upload act for a memo (#551): pick or drop a recording, and it is
 * reserved, PUT straight to object storage with real progress, and finalized.
 * Everything the browser can know before the upload is refused here — the
 * format, the size, and the length the file declares — so nobody waits out a
 * two-hour upload to be told it was too long. The server checks each again.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Mic } from 'lucide-vue-next'
import { MEMO_FORMATS, memoExtensionFor, type CreateMemoResponse } from '@knowledge/contracts'
import { request } from '@/api/client'
import { errorMessage } from '@/api/errors'
import { formatBytes } from '@/lib/format'
import { presignedPut } from '@/lib/presigned-put'
import { Button } from '@/components/ui/button'
import { readDurationSeconds } from './memo-ui'

const props = defineProps<{
  workspaceId: string
  projectId: string | null
  maxBytes: number
  maxMinutes: number
}>()

const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()

const input = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const phase = ref<{ kind: 'reading' | 'uploading'; name: string } | null>(null)
const progress = ref(0)
let abort: AbortController | null = null

const accept = MEMO_FORMATS.flatMap((f) => [f.extension, ...f.contentTypes]).join(',')
const busy = computed(() => phase.value !== null)

async function take(file: File | undefined) {
  if (!file || busy.value || !props.projectId) return
  if (!memoExtensionFor(file.name, file.type)) return void toast.error(t('memos.upload.unsupported', { name: file.name }))
  if (file.size > props.maxBytes) {
    return void toast.error(t('memos.upload.tooLarge', { name: file.name, size: formatBytes(file.size), limit: formatBytes(props.maxBytes) }))
  }

  phase.value = { kind: 'reading', name: file.name }
  const seconds = await readDurationSeconds(file)
  if (seconds !== null && seconds > props.maxMinutes * 60) {
    phase.value = null
    return void toast.error(t('memos.upload.tooLong', { name: file.name, minutes: Math.ceil(seconds / 60), limit: props.maxMinutes }))
  }

  phase.value = { kind: 'uploading', name: file.name }
  progress.value = 0
  abort = new AbortController()
  try {
    const created = (await request('post', '/v1/memos', {
      body: {
        workspaceId: props.workspaceId,
        projectId: props.projectId,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        ...(seconds !== null ? { durationSeconds: seconds } : {}),
      },
      signal: abort.signal,
    })) as CreateMemoResponse
    await presignedPut(created.upload, file, (f) => (progress.value = f), abort.signal)
    await request('post', '/v1/memos/{id}/finalize', { path: { id: created.memo.memoId } })
    await queryClient.invalidateQueries({ queryKey: ['/v1/memos'] })
    await router.push(`/memos/${created.memo.memoId}`)
  } catch (e) {
    if ((e as DOMException)?.name !== 'AbortError') toast.error(errorMessage(e, t))
  } finally {
    phase.value = null
    abort = null
    if (input.value) input.value.value = ''
  }
}

function cancel() {
  abort?.abort()
}

function onDrop(event: DragEvent) {
  dragging.value = false
  void take(event.dataTransfer?.files?.[0])
}
</script>

<template>
  <div
    class="rounded-lg border border-dashed p-5 transition-colors"
    :class="dragging ? 'border-primary bg-accent/40' : 'bg-card'"
    @dragover.prevent="dragging = !busy"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
  >
    <div v-if="!phase" class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button :disabled="!projectId" @click="input?.click()">
        <Mic class="size-4" aria-hidden="true" />
        {{ t('memos.upload.cta') }}
      </Button>
      <span class="text-muted-foreground text-sm">{{ t('memos.upload.drop') }}</span>
      <p class="text-muted-foreground w-full text-xs">
        {{ projectId ? t('memos.upload.hint', { size: formatBytes(maxBytes), minutes: maxMinutes }) : t('memos.noProject') }}
      </p>
      <input ref="input" type="file" class="sr-only" :accept="accept" tabindex="-1" @change="take(($event.target as HTMLInputElement).files?.[0])" />
    </div>

    <div v-else class="flex flex-col gap-2" aria-live="polite">
      <div class="flex items-center justify-between gap-3 text-sm">
        <span class="min-w-0 truncate">
          {{ phase.kind === 'reading' ? t('memos.upload.reading', { name: phase.name }) : t('memos.upload.uploading', { name: phase.name }) }}
        </span>
        <Button v-if="phase.kind === 'uploading'" variant="ghost" size="sm" class="h-7 shrink-0" @click="cancel">
          {{ t('memos.upload.cancel') }}
        </Button>
      </div>
      <div
        class="bg-muted h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        :aria-valuenow="phase.kind === 'uploading' ? Math.round(progress * 100) : undefined"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="t('memos.upload.uploading', { name: phase.name })"
      >
        <div class="bg-primary h-full transition-[width] duration-200" :style="{ width: `${Math.round(progress * 100)}%` }" />
      </div>
    </div>
  </div>
</template>
