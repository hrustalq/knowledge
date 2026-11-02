import { expect, test } from '@playwright/test'

// Collections on pages (#716, phase 3): "New page" under a collection starts
// numbered and from the collection's child template, and the rule is editable
// in page settings on any page.
const API = process.env.E2E_API_URL ?? 'http://localhost:3000'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'

test.describe('collections', () => {
  let projectId: string
  let decisionsId: string
  let gotchasId: string

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${API}/v1/projects/scaffold`, {
      data: { workspaceId: WORKSPACE, name: `Collections ${Date.now()}`, locale: 'en', blueprintKey: 'code-product' },
    })
    expect(res.ok()).toBe(true)
    ;({ project: { projectId } } = await res.json())
    const tree = await request.get(`${API}/v1/documents/tree`, { params: { workspaceId: WORKSPACE, projectId, depth: '1' } })
    const { roots } = (await tree.json()) as { roots: { documentId: string; title: string }[] }
    decisionsId = roots.find((r) => r.title === 'Decisions')!.documentId
    gotchasId = roots.find((r) => r.title === 'Gotchas')!.documentId
  })

  test('New page under Decisions offers ADR 0001 with the ADR template, then ADR 0002', async ({ page, request }) => {
    const title = page.getByRole('textbox', { name: 'Page title' })

    await page.goto(`/create?parent=${decisionsId}`)
    await expect(title).toHaveValue('ADR 0001: ')
    await expect(page.getByText('from Architecture decision record')).toBeVisible()

    const first = await request.post(`${API}/v1/documents`, {
      data: {
        workspaceId: WORKSPACE,
        projectId,
        parentId: decisionsId,
        title: 'ADR 0001: Queue',
        visibility: 'workspace',
        content: { mode: 'inline', format: 'markdown', text: '# ADR 0001: Queue\n\nBody.\n' },
      },
    })
    expect(first.ok()).toBe(true)

    await page.goto(`/create?parent=${decisionsId}`)
    await expect(title).toHaveValue('ADR 0002: ')
  })

  test('the rule is set in page settings, and the next New page follows it', async ({ page }) => {
    await page.goto(`/documents/${gotchasId}/edit`)
    await page.getByRole('button', { name: 'Settings' }).first().click()
    const pattern = page.getByLabel('Title pattern')
    await pattern.fill('G{{n:2}} — ')
    await expect(page.getByText('Next new page:')).toBeVisible()
    await page.getByRole('button', { name: 'Save rule' }).click()
    await expect(page.getByText('Collection rule saved')).toBeVisible()

    await page.goto(`/create?parent=${gotchasId}`)
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('G01 — ')
  })
})
