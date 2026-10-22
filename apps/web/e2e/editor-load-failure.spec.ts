import { expect, test } from '@playwright/test'

// A page that failed to load is never editable (#314): no empty editor, no
// Publish, no working copy — and Retry opens it, joining its shared draft.
const API = process.env.E2E_API_URL ?? 'http://localhost:3000'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'

test('a failed load shows an error state, and Retry opens the page', async ({ page, request }) => {
  const { enabled: coEditing } = await (await request.get(`${API}/v1/collab/capabilities`)).json()
  const project = await request.post(`${API}/v1/projects`, {
    data: { workspaceId: WORKSPACE, name: `Failed load ${Date.now()}` },
  })
  expect(project.ok()).toBe(true)
  const { project: { projectId } } = await project.json()
  const created = await request.post(`${API}/v1/documents`, {
    data: {
      workspaceId: WORKSPACE,
      projectId,
      title: 'Load me',
      content: { mode: 'inline', format: 'markdown', text: '# Load me\n\nThe body.\n' },
    },
  })
  expect(created.ok()).toBe(true)
  const { documentId } = await created.json()

  // The connection drops while the content is in flight.
  const content = `**/v1/documents/${documentId}/content**`
  await page.route(content, (route) => route.abort('internetdisconnected'))
  await page.goto(`/documents/${documentId}/edit`)

  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.locator('.ProseMirror')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /publish/i })).toBeDisabled()
  await page.locator('.kn-bar-start').click()
  await page.keyboard.type('typed into nothing')
  const stored = await page.evaluate((id) => Object.keys(localStorage).filter((k) => k.includes(id)), documentId)
  expect(stored).toEqual([])

  await page.unroute(content)
  await page.getByRole('button', { name: /retry/i }).click()
  await expect(page.locator('.ProseMirror').first()).toContainText('The body.')
  // The `coedit-e2e` CI job runs with co-editing on: Retry joins the shared draft.
  if (coEditing) await expect(page.locator('.kn-collab-status[data-tone="live"]')).toBeVisible()
  await expect(page.getByRole('button', { name: /publish/i })).toBeEnabled()
})
