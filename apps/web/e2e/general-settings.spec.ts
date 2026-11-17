import { expect, test } from '@playwright/test'

for (const width of [390, 1440]) {
  test(`workspace controls live under General at ${width}px`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'kn_lang', value: 'en', url: baseURL! }])
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/settings/general')

    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Workspace name' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link').first()).toHaveText(/General/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)

    await page.getByRole('button', { name: 'Delete workspace…' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Delete workspace', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await page.goto('/settings/access?tab=members')
    await expect(page.getByRole('tab', { name: /Members/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('textbox', { name: 'Workspace name' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Delete workspace…' })).toHaveCount(0)
  })
}
