/**
 * Upload a file to a presigned URL, reporting real progress.
 *
 * XHR rather than fetch for exactly one reason: fetch still cannot report
 * upload progress, and a determinate bar on the part we can actually measure is
 * the difference between a wait that feels accountable and a spinner.
 *
 * Shared by the editor's attachment uploads and the import wizard — both send
 * bytes straight to object storage, and neither should invent its own idea of
 * what "failed" means.
 */
/**
 * An upload failure that carries a message key, not English: this module has no
 * translator (it is not a component, and the i18n instance is per-app for SSR
 * isolation). `errorMessage` in api/errors resolves it; `message` stays English
 * for logs.
 */
export class UploadError extends Error {
  readonly key: 'upload.failedStatus' | 'upload.connectionDropped'
  readonly params: Record<string, string | number>

  constructor(key: UploadError['key'], params: Record<string, string | number>, message: string) {
    super(message)
    this.name = 'UploadError'
    this.key = key
    this.params = params
  }
}

export interface PresignedPut {
  url: string
  headers?: Record<string, string>
}

export function presignedPut(
  target: PresignedPut,
  file: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', target.url, true)
    for (const [k, v] of Object.entries(target.headers ?? {})) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total)
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new UploadError('upload.failedStatus', { status: xhr.status }, `Upload failed (${xhr.status})`))
    xhr.onerror = () =>
      reject(new UploadError('upload.connectionDropped', {}, 'Upload failed — the connection dropped'))
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}
