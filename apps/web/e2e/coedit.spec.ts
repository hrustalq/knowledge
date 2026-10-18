import { expect, test, type Page } from '@playwright/test'

// Two people on one page (#80, docs/features/56): what one types the other
// sees, with a named caret, and the title travels too. Needs COLLAB_ENABLED=true.
const API = process.env.E2E_API_URL ?? 'http://localhost:3000'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'

test('two contexts co-edit one page: body, caret and title', async ({ browser, request }) => {
  const caps = await (await request.get(`${API}/v1/collab/capabilities`)).json()
  expect(caps.enabled, 'the API under test must run with COLLAB_ENABLED=true').toBe(true)

  const project = await request.post(`${API}/v1/projects`, {
    data: { workspaceId: WORKSPACE, name: `Co-editing ${Date.now()}` },
  })
  expect(project.ok()).toBe(true)
  const { project: { projectId } } = await project.json()
  const created = await request.post(`${API}/v1/documents`, {
    data: {
      workspaceId: WORKSPACE,
      projectId,
      title: 'Shared page',
      content: { mode: 'inline', format: 'markdown', text: '# Shared page\n\nSeed paragraph.\n' },
    },
  })
  expect(created.ok()).toBe(true)
  const { documentId } = await created.json()

  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()])
  const [pa, pb] = await Promise.all([a.newPage(), b.newPage()])
  const open = async (page: Page) => {
    await page.goto(`/documents/${documentId}/edit`)
    await expect(page.locator('.kn-collab-status[data-tone="live"]')).toBeVisible()
  }
  await Promise.all([open(pa), open(pb)])
  const bodyA = pa.locator('.ProseMirror').first()
  const bodyB = pb.locator('.ProseMirror').first()

  // Seeded once by the server: both see the page exactly once.
  await expect(bodyA).toContainText('Seed paragraph.')
  await expect(bodyB.getByText('Seed paragraph.')).toHaveCount(1)

  await bodyA.getByText('Seed paragraph.').click()
  await pa.keyboard.press('End')
  const marker = ` typed-in-a-${Date.now()}`
  await pa.keyboard.type(marker)
  await expect(bodyB).toContainText(marker.trim(), { timeout: 2_000 })
  await expect(pb.locator('.kn-caret-label')).toHaveCount(1)

  const titleB = pb.locator('.kn-title-input')
  await titleB.click()
  await pb.keyboard.press('End')
  await pb.keyboard.type(' v2')
  await expect(pa.locator('.kn-title-input')).toHaveValue('Shared page v2')

  // A reload rebuilds from the server and this device's copy: still one page.
  await pa.reload()
  await expect(pa.locator('.kn-collab-status[data-tone="live"]')).toBeVisible()
  await expect(pa.locator('.ProseMirror').first().getByText('Seed paragraph.', { exact: false })).toHaveCount(1)

  await Promise.all([a.close(), b.close()])
})
