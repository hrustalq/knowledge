/**
 * The import flow's state machine: reserve → PUT → start → poll → content.
 *
 * All of it hangs off one server-owned row, which is the reason the wizard can
 * be closed and reopened: the browser holds an id, not the work. The id is
 * parked in sessionStorage so a reload, or a click on a link and a click back,
 * rejoins a parse already in flight instead of throwing away a 50 MB upload.
 */
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CreateImportResponse,
  DocumentCategory,
  ImportContentResponse,
  ImportJobInfo,
  ImportJobResponse,
  SubmitImportResponse,
} from '@knowledge/contracts'
import type { ComposerTranslation } from 'vue-i18n'
import { request } from '@/api/client'
import { presignedPut } from '@/lib/presigned-put'

/** Where the wizard is, as far as the person looking at it is concerned. */
export type ImportPhase = 'choose' | 'working' | 'review' | 'failed'

const RESUME_KEY = 'kn_import_active'
/** Fast enough that a 2-second parse still shows motion; slow enough not to hammer. */
const POLL_MS = 900
/** A parse that has said nothing for this long is treated as lost rather than pending. */
const POLL_TIMEOUT_MS = 10 * 60 * 1000

export function useImport() {
  const { t } = useI18n()

  const job = shallowRef<ImportJobInfo | null>(null)
  const content = shallowRef<ImportContentResponse | null>(null)
  const error = ref<string | null>(null)

  /** 0..1 while the browser is uploading; null once the worker takes over. */
  const uploadProgress = ref<number | null>(null)
  const busy = ref(false)

  let poller: ReturnType<typeof setTimeout> | null = null
  let abort: AbortController | null = null

  const phase = computed<ImportPhase>(() => {
    if (error.value) return 'failed'
    if (!job.value) return 'choose'
    switch (job.value.status) {
      case 'awaiting-upload':
        return uploadProgress.value === null ? 'choose' : 'working'
      case 'queued':
      case 'running':
        return 'working'
      case 'parsed':
      case 'submitted':
        return content.value ? 'review' : 'working'
      case 'failed':
        return 'failed'
      default:
        return 'choose'
    }
  })

  /**
   * What the ring says. The upload half is measured, the parse half is not —
   * so the parse half reports null rather than a number the client invented.
   */
  const progress = computed<number | null>(() => {
    if (uploadProgress.value !== null) return uploadProgress.value
    return job.value?.progress ?? null
  })

  const stage = computed<string>(() => {
    if (uploadProgress.value !== null) return `Uploading ${job.value?.sourceFilename ?? 'file'}`
    return job.value?.stage ?? 'Waiting for a worker'
  })

  async function begin(
    file: File,
    destination: { workspaceId: string; projectId: string; category: DocumentCategory; parentId?: string },
  ): Promise<void> {
    reset()
    busy.value = true
    uploadProgress.value = 0
    abort = new AbortController()

    try {
      const created = (await request('post', '/v1/imports', {
        body: {
          workspaceId: destination.workspaceId,
          projectId: destination.projectId,
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          category: destination.category,
          ...(destination.parentId ? { parentId: destination.parentId } : {}),
        },
        signal: abort.signal,
      })) as CreateImportResponse

      job.value = created.import
      remember(created.import.importId)

      await presignedPut(created.upload, file, (f) => (uploadProgress.value = f), abort.signal)

      // The browser's part is done; from here the ring belongs to the worker.
      uploadProgress.value = null
      const started = (await request('post', '/v1/imports/{id}/start', {
        path: { id: created.import.importId },
      })) as ImportJobResponse
      job.value = started.import
      poll()
    } catch (e) {
      uploadProgress.value = null
      fail(e)
    } finally {
      busy.value = false
    }
  }

  /** Re-attach to a job left running by an earlier visit. */
  async function resume(): Promise<boolean> {
    const id = sessionStorage.getItem(RESUME_KEY)
    if (!id) return false
    try {
      const res = (await request('get', '/v1/imports/{id}', { path: { id } })) as ImportJobResponse
      if (res.import.status === 'submitted') {
        forget()
        return false
      }
      job.value = res.import
      if (res.import.status === 'parsed') await loadContent()
      else if (res.import.status === 'failed') error.value = res.import.error ?? 'The import failed.'
      else poll()
      return true
    } catch {
      // A stale id (discarded, or from another workspace) is not worth a
      // message — the wizard simply opens at step one.
      forget()
      return false
    }
  }

  async function submit(input: {
    title: string
    markdown: string
    projectId?: string
    category?: DocumentCategory
    parentId?: string | null
  }): Promise<SubmitImportResponse | null> {
    const id = job.value?.importId
    if (!id) return null
    busy.value = true
    error.value = null
    try {
      const res = (await request('post', '/v1/imports/{id}/submit', {
        path: { id },
        body: input,
      })) as SubmitImportResponse
      forget()
      return res
    } catch (e) {
      error.value = messageOf(e, t)
      return null
    } finally {
      busy.value = false
    }
  }

  /** Abandoning at the review step is normal — clean the staged files up. */
  async function discard(): Promise<void> {
    const id = job.value?.importId
    stop()
    forget()
    if (id) {
      await request('delete', '/v1/imports/{id}', { path: { id } }).catch(() => undefined)
    }
    reset()
  }

  /** Give up on the current attempt without touching the server row. */
  function reset(): void {
    stop()
    job.value = null
    content.value = null
    error.value = null
    uploadProgress.value = null
  }

  function stop(): void {
    if (poller) clearTimeout(poller)
    poller = null
    abort?.abort()
    abort = null
  }

  function poll(): void {
    const id = job.value?.importId
    if (!id) return
    const deadline = Date.now() + POLL_TIMEOUT_MS

    const tick = async () => {
      try {
        const res = (await request('get', '/v1/imports/{id}', { path: { id } })) as ImportJobResponse
        job.value = res.import
        if (res.import.status === 'parsed') {
          await loadContent()
          return
        }
        if (res.import.status === 'failed') {
          error.value = res.import.error ?? 'The import failed.'
          return
        }
        if (Date.now() > deadline) {
          error.value = 'This import has been running for a very long time. Try again, or import a smaller file.'
          return
        }
        poller = setTimeout(tick, POLL_MS)
      } catch (e) {
        fail(e)
      }
    }
    poller = setTimeout(tick, POLL_MS)
  }

  async function loadContent(): Promise<void> {
    const id = job.value?.importId
    if (!id) return
    content.value = (await request('get', '/v1/imports/{id}/content', {
      path: { id },
    })) as ImportContentResponse
  }

  function fail(e: unknown): void {
    error.value = messageOf(e, t)
  }

  const remember = (id: string) => sessionStorage.setItem(RESUME_KEY, id)
  const forget = () => sessionStorage.removeItem(RESUME_KEY)

  return {
    job,
    content,
    error,
    phase,
    progress,
    stage,
    busy,
    begin,
    resume,
    submit,
    discard,
    reset,
    stop,
  }
}

function messageOf(e: unknown, t: ComposerTranslation): string {
  if (e instanceof DOMException && e.name === 'AbortError') return t('import.uploadCancelled')
  const message = (e as { message?: string })?.message
  return message && message !== 'Request failed' ? message : t('import.somethingWentWrong')
}
