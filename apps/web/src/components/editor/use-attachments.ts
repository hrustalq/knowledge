/**
 * Attachment uploads for the editor: presign → PUT → confirm, then insert the
 * right node. Three steps rather than one multipart POST because file bytes
 * never pass through the API — they go straight to object storage, exactly like
 * document revisions do.
 */
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import type { Editor } from '@tiptap/core'
import type {
  AttachmentSummary,
  CompleteAttachmentResponse,
  CreateAttachmentResponse,
} from '@knowledge/contracts'
import { ATTACHMENT_CONTENT_TYPES } from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'

export interface UploadTask {
  id: string
  filename: string
  progress: number
  error?: string
}

const ACCEPTED = new Set<string>(ATTACHMENT_CONTENT_TYPES)

export function useAttachments(resolveDocumentId: () => Promise<string | null>) {
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

      // Presigned PUT goes direct to storage, so progress comes from XHR
      // rather than fetch — fetch still cannot report upload progress.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', created.upload.url, true)
        for (const [k, v] of Object.entries(created.upload.headers)) xhr.setRequestHeader(k, v)
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) task.progress = 10 + Math.round((event.loaded / event.total) * 85)
        }
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`Upload failed (${xhr.status})`))
        xhr.onerror = () => reject(new Error('Upload failed'))
        xhr.send(file)
      })

      const done = await apiFetch<CompleteAttachmentResponse>(
        `/v1/documents/${documentId}/attachments/${created.attachment.attachmentId}/complete`,
        { method: 'POST' },
      )
      finish()
      return done.attachment
    } catch (e) {
      finish()
      toast.error(`${file.name}: ${(e as Error).message}`)
      return null
    }
  }

  /** Upload files and insert them at the current selection. */
  async function insertFiles(editor: Editor, files: File[]): Promise<void> {
    const accepted = files.filter((f) => ACCEPTED.has(f.type))
    const rejected = files.filter((f) => !ACCEPTED.has(f.type))
    for (const file of rejected) {
      toast.error(`${file.name}: ${file.type || 'this file type'} is not an accepted attachment`)
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
