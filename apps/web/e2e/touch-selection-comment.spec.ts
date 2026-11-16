import { expect, test } from '@playwright/test'

const API = process.env.E2E_API_URL ?? 'http://localhost:3000'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'

test.describe('touch selection commenting', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  let documentId: string
  let mergeRequestId: string

  test.beforeAll(async ({ request }) => {
    const project = await request.post(`${API}/v1/projects`, {
      data: { workspaceId: WORKSPACE, name: `Touch selection ${Date.now()}` },
    })
    expect(project.ok()).toBe(true)
    const { project: { projectId } } = await project.json()
    const created = await request.post(`${API}/v1/documents`, {
      data: {
        workspaceId: WORKSPACE,
        projectId,
        title: 'Touch selection',
        visibility: 'workspace',
        content: { mode: 'inline', format: 'markdown', text: '# Touch selection\n\nSelect this passage to comment.\n' },
      },
    })
    expect(created.ok()).toBe(true)
    ;({ documentId } = await created.json())

    const branch = await request.post(`${API}/v1/documents/${documentId}/branches`, { data: { name: 'touch-review' } })
    expect(branch.ok()).toBe(true)
    const revision = await request.post(`${API}/v1/documents/${documentId}/revisions`, {
      data: { branch: 'touch-review', contentType: 'text/markdown' },
    })
    expect(revision.ok()).toBe(true)
    const { revisionId } = await revision.json()
    const markdown = '# Touch selection\n\nSelect this passage to comment in review.\n'
    const upload = await request.post(`${API}/v1/documents/${documentId}/uploads`, {
      data: { revisionId, contentType: 'text/markdown', filename: 'source.md', sizeBytes: Buffer.byteLength(markdown) },
    })
    expect(upload.ok()).toBe(true)
    const { upload: { url } } = await upload.json()
    const put = await request.put(url, { data: markdown, headers: { 'Content-Type': 'text/markdown' } })
    expect(put.ok()).toBe(true)
    const finalized = await request.post(`${API}/v1/documents/${documentId}/revisions/${revisionId}/finalize`, { data: {} })
    expect(finalized.ok()).toBe(true)
    const mr = await request.post(`${API}/v1/documents/${documentId}/merge-requests`, {
      data: { sourceBranch: 'touch-review', title: 'Touch selection review' },
    })
    expect(mr.ok()).toBe(true)
    ;({ mergeRequest: { mergeRequestId } } = await mr.json())
  })

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: 'kn_lang', value: 'en', url: baseURL! }])
  })

  for (const surface of ['page', 'review'] as const) {
    test(`${surface}: selectionchange opens the actions and Comment opens the composer`, async ({ page }) => {
      await page.goto(surface === 'page' ? `/documents/${documentId}` : `/merge-requests/${mergeRequestId}?tab=review`)
      const body = page.getByRole('textbox', { name: 'Page body' })
      await expect(body).toBeVisible({ timeout: 15_000 })
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true)
      const paragraph = body.locator('p').filter({ hasText: 'Select this passage to comment' })
      await expect(paragraph).toBeVisible()
      await paragraph.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })

      const comment = page.getByRole('button', { name: 'Comment', exact: true })
      await expect(comment).toBeVisible()
      await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible()
      const anchor = (await paragraph.boundingBox())!
      const action = (await comment.boundingBox())!
      expect(action.y).toBeGreaterThanOrEqual(anchor.y + anchor.height)

      await comment.tap()
      await expect(page.getByRole('textbox', { name: 'Write a comment…' })).toBeVisible()
    })
  }
})
