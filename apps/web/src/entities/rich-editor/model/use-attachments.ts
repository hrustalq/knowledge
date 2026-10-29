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
} from '@knowledge/contracts'
import { ATTACHMENT_CONTENT_TYPES } from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { presignedPut } from '@/shared/api/presigned-put'
import { errorMessage } from '@/shared/api/errors'

export interface UploadTask {
  id: string
  filename: string
  progress: number
  error?: string
}

const ACCEPTED = new Set<string>(ATTACHMENT_CONTENT_TYPES)

/**
 * Names a camera, the OS or the clipboard made up: a screen reader announcing
 * "Screenshot 2026-10-21 at 10.22.33.png" is worse than announcing nothing.
 */
const GENERATED_NAME =
  /^(?:image|img|pasted(?:[\s_-]?image)?|clipboard|screenshot|screen[\s_-]?shot|снимок(?:[\s_]экрана)?|photo|dsc|pxl|untitled|frame|capture)?[\s\d_.:()@,+-]*(?:at|в)?[\s\d_.:()@,+-]*$|^[0-9a-f_-]{8,}$/i

/**
 * The alt an upload starts with. There is no alt editor in the page yet, so a
 * generated name becomes `""` (decorative) and an authored one is read as
 * words — "release-flow.png" → "release flow".
 */
function altFromFilename(filename: string): string {
  const stem = filename.replace(/\.[a-z0-9]{2,5}$/i, '').trim()
  if (!stem || GENERATED_NAME.test(stem)) return ''
  return stem.replace(/[\s_-]+/g, ' ').trim()
}

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
      const created = await api.post('/v1/documents/{id}/attachments', {
        path: { id: documentId },
        body: {
          filename: file.name,
          // insertFiles only hands over files whose type is in the list.
          contentType: file.type as (typeof ATTACHMENT_CONTENT_TYPES)[number],
          sizeBytes: file.size,
        },
        config: { timeout: 0 },
      })
      task.progress = 10

      // Presigned PUT goes direct to storage; the shared helper is the same one
      // the import wizard uses, so both report progress and failure identically.
      await presignedPut(created.upload, file, (fraction) => {
        task.progress = 10 + Math.round(fraction * 85)
      })

      const done = await api.post('/v1/documents/{id}/attachments/{attachmentId}/complete', {
        path: { id: documentId, attachmentId: created.attachment.attachmentId },
        config: { timeout: 0 },
      })
      finish()
      return done.attachment
    } catch (e) {
      finish()
      toast.error(t('editor.attachmentFailed', { name: file.name, error: errorMessage(e, t) }))
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
          .setImage({ src: attachment.url, alt: altFromFilename(attachment.filename) })
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
