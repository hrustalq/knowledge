import { expect, test } from '@playwright/test'

// Three accessibility gaps Lighthouse cannot see, because each lives in a state
// it never opens (#649).
const API = process.env.E2E_API_URL ?? 'http://localhost:3000'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'kn_lang', value: 'en', url: baseURL! }])
})

test('the editor body is a labelled multi-line textbox', async ({ page, request }) => {
  const project = await request.post(`${API}/v1/projects`, {
    data: { workspaceId: WORKSPACE, name: `A11y ${Date.now()}` },
  })
  expect(project.ok()).toBe(true)
  const { project: { projectId } } = await project.json()
  const created = await request.post(`${API}/v1/documents`, {
    data: {
      workspaceId: WORKSPACE,
      projectId,
      title: 'Labelled body',
      visibility: 'workspace',
      content: { mode: 'inline', format: 'markdown', text: '# Labelled body\n\nText.\n' },
    },
  })
  expect(created.ok()).toBe(true)
  const { documentId } = await created.json()

  await page.goto(`/documents/${documentId}/edit`)
  const body = page.getByRole('textbox', { name: 'Page body' })
  await expect(body).toBeVisible({ timeout: 15_000 })
  await expect(body).toHaveAttribute('aria-multiline', 'true')
})

test('a collapsed sub-rail is out of the tab order', async ({ page }) => {
  await page.goto('/merge-requests')
  const closed = page.locator('.kn-subrail[data-open=false] .kn-subrail-inner')
  await expect(closed).toHaveCount(1)
  await expect(closed).toHaveAttribute('inert', '')
})

test('opening notifications focuses the panel, not "Mark all as read"', async ({ page }) => {
  await page.goto('/merge-requests')
  const bell = page.getByRole('button', { name: /^Notifications/ })
  const panel = page.locator('[data-slot=popover-content]')
  // A click that lands before hydration does nothing; retry only while closed.
  await expect(async () => {
    if (!(await panel.isVisible())) await bell.click()
    await expect(panel).toBeVisible({ timeout: 1000 })
  }).toPass()
  await expect(panel).toBeFocused()
})
