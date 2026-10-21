import { createRequire } from 'node:module'
import { expect, test, type Page } from '@playwright/test'
import { mermaidConfig } from '../src/lib/mermaid.ts'

// The app's Mermaid config through the app's sanitize call (#438). Needs no
// stack: the installed mermaid and DOMPurify bundles are loaded into a blank
// page, because Mermaid lays text out with getBBox, which jsdom cannot.
const require = createRequire(import.meta.url)

async function render(page: Page, source: string) {
  await page.setContent('<div id="out"></div>')
  await page.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min.js') })
  await page.addScriptTag({ path: require.resolve('dompurify/dist/purify.min.js') })
  await page.evaluate(
    async ({ config, source }) => {
      type Api = {
        mermaid: { initialize(c: unknown): void; render(id: string, s: string): Promise<{ svg: string }> }
        DOMPurify: { sanitize(s: string, o: unknown): string }
        document: { getElementById(id: string): { innerHTML: string } }
      }
      const g = globalThis as unknown as Api
      g.mermaid.initialize(config)
      const { svg } = await g.mermaid.render('mmd-test', source)
      g.document.getElementById('out').innerHTML = g.DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      })
    },
    { config: mermaidConfig(false), source },
  )
  return page.locator('#out svg')
}

for (const init of ['', '%%{init: {"flowchart": {"htmlLabels": false}}}%%\n']) {
  test(`flowchart labels survive sanitizing${init ? ' with a flowchart init directive' : ''}`, async ({ page }) => {
    const svg = await render(page, `${init}flowchart LR\n  A[Upload] -->|presigned PUT| B[Finalize]\n  B --> C{Indexed?}`)
    await expect(svg.locator('foreignObject')).toHaveCount(0)
    for (const label of ['Upload', 'Finalize', 'Indexed?', 'presigned PUT']) {
      await expect(svg.getByText(label, { exact: true })).toHaveCount(1)
    }
  })
}

test('a sequence diagram draws each participant once', async ({ page }) => {
  const svg = await render(page, 'sequenceDiagram\n  participant Alice\n  participant Bob\n  Alice->>Bob: hi')
  await expect(svg.locator('text.actor', { hasText: 'Alice' })).toHaveCount(1)
  await expect(svg.locator('text.actor', { hasText: 'Bob' })).toHaveCount(1)
})

test('an init directive can turn the mirrored participants back on', async ({ page }) => {
  const svg = await render(
    page,
    '%%{init: {"sequence": {"mirrorActors": true}}}%%\nsequenceDiagram\n  participant Alice\n  Alice->>Alice: hi',
  )
  await expect(svg.locator('text.actor', { hasText: 'Alice' })).toHaveCount(2)
})
