import type { Ref } from 'vue'
import { api, isApiRequestError } from '@/shared/api/queries'
import { presignedPut } from '@/shared/api/presigned-put'

/**
 * Save a spec or fixture as a new revision: upload straight to storage, then
 * finalize — the page editor's path.
 *
 * `viaReview` (#958): in a `review` workspace only an admin writes to a
 * published page directly, so everyone else saves onto their working branch
 * and publishes it — merged at once when no gate holds it, otherwise a merge
 * request, whose id comes back as `heldBy`.
 */
export async function saveStructuredRevision(opts: {
  documentId: string
  contentType: string
  filename: string
  text: string
  /** A draft a failed finalize left behind, retried by the next save. */
  pending: Ref<string | null>
  viaReview: boolean
  title: string
}): Promise<{ deduplicated: boolean; heldBy: string | null }> {
  const path = { id: opts.documentId }
  const { contentType } = opts
  const working = opts.viaReview ? (await api.post('/v1/documents/{id}/branches/mine', { path })).branch : null
  let revisionId = opts.pending.value
  if (!revisionId) {
    // No branch: the server picks the default one.
    const rev = await api.post('/v1/documents/{id}/revisions', { path, body: { contentType, ...(working ? { branch: working.name } : {}) } })
    revisionId = rev.revisionId
  }
  const up = await api.post('/v1/documents/{id}/uploads', { path, body: { revisionId, contentType, filename: opts.filename }, config: { timeout: 0 } })
  await presignedPut({ url: up.upload.url, headers: { 'Content-Type': contentType } }, new Blob([opts.text], { type: contentType }))
  let deduplicated: boolean
  try {
    const fin = await api.post('/v1/documents/{id}/revisions/{revisionId}/finalize', { path: { ...path, revisionId }, config: { timeout: 0 } })
    opts.pending.value = null
    deduplicated = fin.deduplicated === true
  } catch (e) {
    // A 409 means the page moved on since this draft was opened (#806): a
    // retry on the same draft would only refuse again, so the next save starts over.
    opts.pending.value = isApiRequestError(e) && e.status === 409 ? null : revisionId
    throw e
  }
  if (!working || deduplicated) return { deduplicated, heldBy: null }
  // ponytail: a working branch the page moved past refuses here with the API's message; add the
  // page editor's "publish on top" review if structured pages see concurrent edits.
  const res = await api.post('/v1/documents/{id}/branches/{branchId}/publish', {
    path: { ...path, branchId: working.branchId },
    body: { title: opts.title },
    config: { timeout: 0 },
  })
  return { deduplicated, heldBy: res.merged ? null : res.mergeRequest.mergeRequestId }
}
