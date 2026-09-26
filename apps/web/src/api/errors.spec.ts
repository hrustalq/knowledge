import { describe, expect, it } from 'vitest'
import { UploadError } from '@/lib/presigned-put'
import { errorMessage } from './errors'

/**
 * `presignedPut` has no translator, so its failures carry a message key and
 * `errorMessage` resolves it — the English `message` is for logs only (#85).
 */
describe('errorMessage', () => {
  const t = (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}`

  it('translates an upload failure by key, with its parameters', () => {
    const error = new UploadError('upload.failedStatus', { status: 503 }, 'Upload failed (503)')
    expect(errorMessage(error, t)).toBe('upload.failedStatus{"status":503}')
  })

  it('keeps an English message for logs', () => {
    expect(new UploadError('upload.connectionDropped', {}, 'Upload failed — the connection dropped').message).toBe(
      'Upload failed — the connection dropped',
    )
  })

  it('falls back to the generic message for an empty error', () => {
    expect(errorMessage(new Error(''), t)).toBe('common.unknownError')
  })
})
