<script setup lang="ts">
/**
 * A share link's Download (docs/features/43, #161): the reader picks a format,
 * the API queues an export of exactly what the link shows, and this polls the
 * job until the file is ready, then starts the download.
 *
 * The format choice is the app's own (ExportFormatPicker); what differs is
 * only the transport. There is no API client or query cache in the reader, so
 * the calls are plain `fetch` with the unlock cookie, as the password gate's
 * are, and the reader polls because an anonymous job has no inbox to notify.
 * The download itself is a plain navigation: the API 302s to a short-lived
 * URL that answers as an attachment, so the page stays where it is.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download, Loader2 } from 'lucide-vue-next'
import {
  isActiveExportStatus,
  isApiErrorPayload,
  type ExportFormat,
  type PublicShareDownloadOffer,
  type PublicShareExport,
} from '@knowledge/contracts'
import { publicShareExportPath, publicShareExportsPath } from '@knowledge/contracts/publishing'
import { exportFormatAvailable } from '@/core/export-formats'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import ExportFormatPicker from '@/modules/documents/components/ExportFormatPicker.vue'

const props = defineProps<{
  token: string
  apiBase: string
  title: string
  /** The link includes the pages under its page. */
  subtree: boolean
  offer: PublicShareDownloadOffer
}>()

const POLL_MS = 1500

const { t, locale } = useI18n()
const open = ref(false)
const format = ref<ExportFormat>('zip')
const phase = ref<'choose' | 'starting' | 'waiting' | 'ready' | 'failed'>('choose')
const job = ref<PublicShareExport | null>(null)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
/** Bumped on every reset, so a poll answering after the dialog closed is dropped. */
let generation = 0

const choosing = computed(() => phase.value === 'choose' || phase.value === 'starting')
const href = computed(() => (job.value ? `${props.apiBase}${publicShareExportPath(props.token, job.value.id, true)}` : ''))

function stop() {
  generation++
  clearTimeout(timer)
}

function reset() {
  stop()
  phase.value = 'choose'
  job.value = null
  error.value = ''
}

// Each opening starts over, like the app's dialog: last time's file is not this one's.
watch(open, (isOpen) => (isOpen ? reset() : stop()))
onBeforeUnmount(stop)

type Answer = { ok: true; job: PublicShareExport } | { ok: false; status: number; message: string | null }

async function call(path: string, body?: { format: ExportFormat }): Promise<Answer> {
  try {
    const res = await fetch(`${props.apiBase}${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Accept-Language': locale.value, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const payload: unknown = await res.json().catch(() => null)
    if (res.ok) return { ok: true, job: payload as PublicShareExport }
    return { ok: false, status: res.status, message: isApiErrorPayload(payload) ? payload.message : null }
  } catch {
    return { ok: false, status: 0, message: null }
  }
}

function fail(status: number, message: string | null) {
  // The unlock lapsed: the server renders the password gate again.
  if (status === 401) return window.location.reload()
  phase.value = 'failed'
  error.value =
    status === 429
      ? t('shareReader.downloadRateLimited')
      : status === 404
        ? t('shareReader.downloadGone')
        : (message ?? t('shareReader.downloadFailed'))
}

function track(next: PublicShareExport) {
  job.value = next
  if (isActiveExportStatus(next.status)) {
    phase.value = 'waiting'
    const mine = generation
    timer = setTimeout(async () => {
      const res = await call(publicShareExportPath(props.token, next.id))
      if (mine !== generation) return
      if (res.ok) track(res.job)
      else fail(res.status, res.message)
    }, POLL_MS)
    return
  }
  if (next.status === 'completed') {
    phase.value = 'ready'
    window.location.assign(href.value)
    return
  }
  fail(0, next.error?.message ?? null)
}

async function start() {
  if (phase.value !== 'choose' || !exportFormatAvailable(props.offer.formats, format.value)) return
  phase.value = 'starting'
  const mine = generation
  const res = await call(publicShareExportsPath(props.token), { format: format.value })
  if (mine !== generation) return
  if (res.ok) track(res.job)
  else fail(res.status, res.message)
}
</script>

<template>
  <Button variant="ghost" size="sm" class="h-8 gap-1.5 text-muted-foreground hover:text-foreground" @click="open = true">
    <Download class="size-4" aria-hidden="true" />
    {{ t('shareReader.download') }}
  </Button>

  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="truncate">{{ t('shareReader.downloadTitle', { title }) }}</DialogTitle>
        <DialogDescription>
          {{
            subtree
              ? t('shareReader.downloadScopeSubtree', { hours: offer.ttlHours })
              : t('shareReader.downloadScopePage', { hours: offer.ttlHours })
          }}
        </DialogDescription>
      </DialogHeader>

      <form v-if="choosing" id="kn-share-download" @submit.prevent="start">
        <ExportFormatPicker v-model="format" :formats="offer.formats" />
      </form>
      <p v-else-if="phase === 'waiting'" class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 class="size-4 animate-spin" aria-hidden="true" />
        {{ job?.stage ? t(`export.stage.${job.stage}`) : t('shareReader.downloadWaiting') }}
      </p>
      <p v-else-if="phase === 'ready'" class="text-sm" role="status">{{ t('shareReader.downloadReady') }}</p>
      <p v-else class="text-sm text-destructive" role="alert">{{ error }}</p>

      <DialogFooter>
        <Button
          v-if="choosing"
          type="submit"
          form="kn-share-download"
          :disabled="phase === 'starting' || !exportFormatAvailable(offer.formats, format)"
        >
          {{ phase === 'starting' ? t('shareReader.downloadStarting') : t('shareReader.downloadStart') }}
        </Button>
        <template v-else-if="phase === 'ready'">
          <Button variant="ghost" @click="reset">{{ t('shareReader.downloadAnother') }}</Button>
          <Button as-child>
            <a :href="href">{{ t('shareReader.downloadFile') }}</a>
          </Button>
        </template>
        <Button v-else-if="phase === 'failed'" variant="ghost" @click="reset">{{ t('shareReader.downloadRetry') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
