import { expect, test } from '@playwright/test'

// The top bar fits a phone in both languages (#647): the Russian search
// placeholder once kept the trigger at its full width and pushed the account
// menu off the right edge.
for (const locale of ['ru', 'en']) {
  for (const width of [360, 390]) {
    test(`top bar fits ${width}px in ${locale}`, async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: 'kn_lang', value: locale, url: baseURL! }])
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/merge-requests')

      const header = page.locator('header').first()
      await expect(header).toBeVisible()
      expect(await header.evaluate((h) => h.scrollWidth)).toBe(width)
      // The account menu is the bar's last control.
      const box = await header.locator('button').last().boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      expect(box!.width).toBeGreaterThanOrEqual(24)
    })
  }
}
