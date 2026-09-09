/**
 * Attachment uploads for the editor: presign → PUT → confirm, then insert the
 * right node. Three steps rather than one multipart POST because file bytes
 * never pass through the API — they go straight to object storage, exactly like
 * document revisions do.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { Editor } from '@tiptap/core'
import type {
  AttachmentSummary,
  CompleteAttachmentResponse,
  CreateAttachmentResponse,
} from '@knowledge/contracts'
import { ATTACHMENT_CONTENT_TYPES } from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { presignedPut } from '@/lib/presigned-put'

export interface UploadTask {
  id: string
  filename: string
  progress: number
  error?: string
}

const ACCEPTED = new Set<string>(ATTACHMENT_CONTENT_TYPES)

export function useAttachments(resolveDocumentId: () => Promise<string | null>) {
  const { t } = useI18n()

  const uploads = ref<UploadTask[]>([])

  async function uploadOne(file: File, documentId: string): Promise<AttachmentSummary | null> {
    const task: UploadTask = { id: `${file.name}-${Date.now()}`, filename: file.name, progress: 0 }
    uploads.value = [...uploads.value, task]
    const finish = () => {
      uploads.value = uploads.value.filter((u) => u.id !== task.id)
    }

    try {
      const created = await apiFetch<CreateAttachmentResponse>(
        `/v1/documents/${documentId}/attachments`,
        {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          }),
        },
      )
      task.progress = 10

      // Presigned PUT goes direct to storage; the shared helper is the same one
      // the import wizard uses, so both report progress and failure identically.
      await presignedPut(created.upload, file, (fraction) => {
        task.progress = 10 + Math.round(fraction * 85)
      })

      const done = await apiFetch<CompleteAttachmentResponse>(
        `/v1/documents/${documentId}/attachments/${created.attachment.attachmentId}/complete`,
        { method: 'POST' },
      )
      finish()
      return done.attachment
    } catch (e) {
      finish()
      toast.error(t('editor.attachmentFailed', { name: file.name, error: (e as Error).message }))
      return null
    }
  }

  /** Upload files and insert them at the current selection. */
  async function insertFiles(editor: Editor, files: File[]): Promise<void> {
    const accepted = files.filter((f) => ACCEPTED.has(f.type))
    const rejected = files.filter((f) => !ACCEPTED.has(f.type))
    for (const file of rejected) {
      toast.error(
        t('editor.attachmentTypeRejected', { name: file.name, type: file.type || t('editor.thisFileType') }),
      )
    }
    if (accepted.length === 0) return

    const documentId = await resolveDocumentId()
    if (!documentId) return

    for (const file of accepted) {
      const attachment = await uploadOne(file, documentId)
      if (!attachment) continue
      if (attachment.contentType.startsWith('image/')) {
        editor
          .chain()
          .focus()
          .setImage({ src: attachment.url, alt: attachment.filename })
          .run()
      } else {
        editor
          .chain()
          .focus()
          .setFileEmbed({
            attachmentId: attachment.attachmentId,
            filename: attachment.filename,
            mime: attachment.contentType,
            size: attachment.sizeBytes,
            href: attachment.url,
          })
          .run()
      }
    }
  }

  /** File picker, reused by the toolbar and the slash menu. */
  function pickFiles(editor: Editor, accept: string): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = accept
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])]
      if (files.length) void insertFiles(editor, files)
    })
    input.click()
  }

  return { uploads, insertFiles, pickFiles }
}
