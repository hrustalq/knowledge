// SPIKE #80: two browser contexts co-edit one page through the real editor.
import { expect, test } from '@playwright/test'

const page = '/documents/b15a6532-2a1a-4f47-a9e7-37b54b1a0374/edit'

test('a keystroke in one context reaches the other, with a named caret', async ({ browser }) => {
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()])
  const [pa, pb] = await Promise.all([a.newPage(), b.newPage()])
  await pa.goto(`${page}?collab=ada`)
  await pb.goto(`${page}?collab=bob`)
  const ea = pa.locator('.ProseMirror').first(), eb = pb.locator('.ProseMirror').first()
  await expect(ea).toBeVisible()
  await expect(eb).toBeVisible()
  await pa.waitForFunction(() => (window as any).__spike?.provider?.isSynced)
  await pb.waitForFunction(() => (window as any).__spike?.provider?.isSynced)
  await ea.click()
  await pa.keyboard.press('End')
  const marker = `pw-${Date.now()}`
  const t0 = Date.now()
  await pa.keyboard.type(marker)
  await expect(eb).toContainText(marker, { timeout: 2000 })
  console.log(`visible in other context after ${Date.now() - t0} ms (incl. typing ${marker.length} chars)`)
  await expect(pb.locator('.collaboration-carets__label', { hasText: 'ada' })).toHaveCount(1)
})
