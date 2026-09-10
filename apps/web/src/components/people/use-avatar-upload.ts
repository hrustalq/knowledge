import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  type AvatarUrl,
  type CompleteAvatarUploadResponse,
  type CreateAvatarUploadResponse,
} from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { presignedPut } from '@/lib/presigned-put'

/**
 * Uploading a picture for a person or a project (docs/features/23).
 *
 * The three steps the API asks for, in the shape `use-attachments.ts` already
 * established — reserve, PUT the bytes straight to storage, confirm — sharing
 * `presignedPut` with the editor and the import wizard so all three report
 * progress and failure the same way.
 *
 * `base` is the route prefix (`/v1/me` or `/v1/projects/<id>`), which is the
 * only thing that differs between the two kinds.
 */
export function useAvatarUpload(base: () => string) {
  const { t } = useI18n()
  const busy = ref(false)
  const progress = ref(0)

  /**
   * Rejected here as well as server-side, and deliberately not only there: the
   * point of a limit is to be told before a 4 MB photograph goes over a phone
   * connection, not after.
   */
  function validate(file: File): string | null {
    if (!AVATAR_CONTENT_TYPES.includes(file.type as (typeof AVATAR_CONTENT_TYPES)[number])) {
      return t('avatar.badType')
    }
    if (file.size > AVATAR_MAX_BYTES) {
      return t('avatar.tooLarge', { limit: Math.round(AVATAR_MAX_BYTES / 1024 / 1024) })
    }
    return null
  }

  async function upload(file: File): Promise<AvatarUrl | undefined> {
    const problem = validate(file)
    if (problem) {
      toast.error(problem)
      return undefined
    }

    busy.value = true
    progress.value = 0
    try {
      const created = await apiFetch<CreateAvatarUploadResponse>(`${base()}/avatar`, {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        }),
      })
      // Real bytes, so real progress: XHR, because fetch cannot report an
      // upload's progress at all.
      await presignedPut(created.upload, file, (fraction) => {
        progress.value = Math.round(fraction * 95)
      })
      const done = await apiFetch<CompleteAvatarUploadResponse>(`${base()}/avatar/complete`, {
        method: 'POST',
        body: JSON.stringify({ uploadId: created.uploadId, filename: file.name }),
      })
      progress.value = 100
      toast.success(t('avatar.updated'))
      return done.avatarUrl
    } catch (e) {
      toast.error(t('avatar.failed', { error: (e as Error).message }))
      return undefined
    } finally {
      busy.value = false
    }
  }

  async function remove(): Promise<boolean> {
    busy.value = true
    try {
      await apiFetch(`${base()}/avatar`, { method: 'DELETE' })
      toast.success(t('avatar.removed'))
      return true
    } catch (e) {
      toast.error(t('avatar.failed', { error: (e as Error).message }))
      return false
    } finally {
      busy.value = false
    }
  }

  return { busy, progress, upload, remove, accept: AVATAR_CONTENT_TYPES.join(',') }
}
