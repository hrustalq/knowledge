import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// The editor's action bar fits a phone in both languages (#681): even folded to
// icons its end group was ~500px wide in Russian, so Save draft and Publish sat
// off-screen. Below a 30rem bar the secondary actions move into More.
const API = process.env.E2E_API_URL ?? 'http://localhost:3000'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const messages = (locale: string) =>
  JSON.parse(readFileSync(new URL(`../src/shared/i18n/messages/${locale}.json`, import.meta.url), 'utf8'))

test.describe('editor bar on a phone', () => {
  let documentId: string

  test.beforeAll(async ({ request }) => {
    const project = await request.post(`${API}/v1/projects`, {
      data: { workspaceId: WORKSPACE, name: `Editor bar ${Date.now()}` },
    })
    expect(project.ok()).toBe(true)
    const { project: { projectId } } = await project.json()
    // Published at once, so its editor opens on a working branch: Save draft and Publish both show.
    const created = await request.post(`${API}/v1/documents`, {
      data: {
        workspaceId: WORKSPACE,
        projectId,
        title: 'Editor bar page',
        visibility: 'workspace',
        content: { mode: 'inline', format: 'markdown', text: '# Editor bar page\n\nBody.\n' },
      },
    })
    expect(created.ok()).toBe(true)
    ;({ documentId } = await created.json())
  })

  for (const locale of ['ru', 'en']) {
    for (const width of [360, 390]) {
      test(`fits ${width}px in ${locale}`, async ({ page, context, baseURL }) => {
        const m = messages(locale)
        await context.addCookies([{ name: 'kn_lang', value: locale, url: baseURL! }])
        await page.setViewportSize({ width, height: 780 })
        await page.goto(`/documents/${documentId}/edit`)

        const bar = page.locator('#kn-page-toolbar')
        const end = bar.locator('.kn-bar-end')
        const publish = end.getByRole('button', { name: m.editor.publish, exact: true })
        const saveDraft = end.getByRole('button', { name: m.editor.saveDraft, exact: true })
        await expect(publish).toBeVisible()
        await expect(saveDraft).toBeVisible()

        expect(await bar.evaluate((b) => b.scrollWidth - b.clientWidth)).toBe(0)
        for (const button of [publish, saveDraft]) {
          const box = (await button.boundingBox())!
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(width)
          expect(box.width).toBeGreaterThanOrEqual(24)
          expect(box.height).toBeGreaterThanOrEqual(24)
        }

        // What left the bar is in More, under the same names.
        await end.getByRole('button', { name: m.editor.moreActions }).click()
        const menu = page.getByRole('menu')
        await expect(menu.getByRole('menuitem', { name: m.editor.settings })).toBeVisible()
        await expect(menu.getByRole('menuitem', { name: m.common.cancel })).toBeVisible()
      })
    }
  }
})
