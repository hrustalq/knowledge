import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { plantumlClassicScript, plantumlProblemOf } from '../src/shared/utils/plantuml.ts'

// The vendored engine through the app's sanitize call (docs/features/87). Needs
// no stack: the engine, Graphviz and the C4 stdlib are local files, loaded into
// a blank page, because PlantUML lays text out with canvas, which jsdom cannot.
//
// The stdlib is delivered by pre-loading `c4.min.js` and answering the engine's
// loader callback, so the test makes no request at all — the same two files an
// `!include <C4/…>` resolves to in the app.
const require = createRequire(import.meta.url)
const vendored = (name: string) => fileURLToPath(new URL(`../public/plantuml/${name}`, import.meta.url))

/** The use-case block: actors, a rectangle of ovals, `[[url label]]` links and include/extend edges. */
const USE_CASE = `@startuml
left to right direction
actor User as U
rectangle OMS {
  usecase "[[https://example.test/documents/abc#create Создать заказ]]" as UC2
  usecase "[[https://example.test/documents/abc#check Проверить возможность\\nформирования заказа]]" as UC3
  usecase "Согласовать заказ" as UC4
  UC2 .> UC3 : include
}
U --> UC2
U --> UC4
@enduml`

/** The C4 block: the reproducer's shape — ROLF and OMS boundaries from the C4 stdlib. */
const C4 = `@startuml
!include <C4/C4_Context>
!include <C4/C4_Container>
skinparam wrapWidth 600
Person(user, "Пользователь OMS", "Сотрудник Рольф")
Boundary(rolf, "ROLF") {
  Boundary(oms, "OMS") {
    Container(omsBe, "OMS BE", "Backend OMS", "NestJS")
  }
}
System_Ext(mdm, "MDM", "Мастер-данные")
Rel(user, omsBe, "UI")
Rel(omsBe, mdm, "JSON/HTTPS")
@enduml`

async function draw(page: Page, source: string) {
  await page.setContent('<div id="out"></div>')
  await page.addScriptTag({ path: vendored('viz-global.js') })
  await page.addScriptTag({ path: vendored('c4.min.js') })
  await page.addScriptTag({
    content: 'window.PLANTUML_STDLIB_LOADER = function (name, ok) { ok(); return true; };',
  })
  await page.addScriptTag({ content: plantumlClassicScript(readFileSync(vendored('plantuml.js'), 'utf8')) })
  await page.addScriptTag({ path: require.resolve('dompurify/dist/purify.min.js') })
  await page.evaluate(async ({ source }) => {
    type Api = {
      PlantUML: {
        renderToString(
          lines: string[],
          ok: (svg: string) => void,
          fail: (message: string) => void,
          options: { dark?: boolean },
        ): void
      }
      DOMPurify: { sanitize(svg: string, options: unknown): string }
    }
    const api = globalThis as unknown as Api
    const svg = await new Promise<string>((resolve, reject) => {
      api.PlantUML.renderToString(source.split(/\r?\n/), resolve, reject, { dark: false })
    })
    // The engine reports a syntax error by drawing one; a drawing here must not be that.
    if (svg.includes('fill="#33FF02"')) throw new Error(`PlantUML error drawing: ${svg.slice(0, 400)}`)
    document.getElementById('out')!.innerHTML = api.DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
    })
  }, { source })
  return page.locator('#out svg')
}

test('a use-case diagram draws its ovals, links and labels', async ({ page }) => {
  const svg = await draw(page, USE_CASE)
  await expect(svg).toHaveCount(1)
  // Labels survive the SVG sanitize profile the read view uses.
  for (const label of ['Создать заказ', 'Согласовать заказ', 'Проверить возможность', 'OMS']) {
    await expect(svg.getByText(label, { exact: true }).first()).toBeVisible()
  }
  // A creole link stays a link: the oval opens the page it describes.
  await expect(svg.locator('a[href="https://example.test/documents/abc#create"]')).toHaveCount(1)
  await expect(svg.locator('foreignObject')).toHaveCount(0)
})

test('a C4 container diagram draws from the C4 stdlib', async ({ page }) => {
  const svg = await draw(page, C4)
  await expect(svg.locator('foreignObject')).toHaveCount(0)
  // Single-word labels are one <text> each and must be visible as such…
  for (const label of ['ROLF', 'OMS', 'MDM']) {
    await expect(svg.getByText(label, { exact: true }).first()).toBeVisible()
  }
  // …while C4 draws a multi-word name word by word, so those are read as the drawing's text.
  for (const label of ['OMS BE', 'Пользователь OMS', 'Backend OMS', '«external_system»', '«container»']) {
    await expect(svg).toContainText(label)
  }
  await expect(svg).toContainText('JSON/HTTPS')
})

test('a syntax error is an error drawing, and is recognised as one', async ({ page }) => {
  await page.setContent('<div id="out"></div>')
  await page.addScriptTag({ path: vendored('viz-global.js') })
  await page.addScriptTag({ content: plantumlClassicScript(readFileSync(vendored('plantuml.js'), 'utf8')) })
  const svg: string = await page.evaluate(async () => {
    type Api = { PlantUML: { renderToString(l: string[], ok: (s: string) => void, fail: (m: string) => void): void } }
    const api = globalThis as unknown as Api
    return new Promise((resolve) => {
      api.PlantUML.renderToString(['@startuml', 'class Foo {', '@enduml'], resolve, resolve)
    })
  })
  expect(plantumlProblemOf(svg)).toMatchObject({ line: 2, message: expect.stringContaining('Syntax Error?') })
})

test('a `!theme` from the vendored catalogue draws (the wrapper loads themes.js on demand)', async ({ page }) => {
  await page.setContent('<div id="out"></div>')
  await page.addScriptTag({ path: vendored('viz-global.js') })
  // What the wrapper does when a source names a theme.
  await page.addScriptTag({ path: vendored('themes.js') })
  await page.addScriptTag({ content: plantumlClassicScript(readFileSync(vendored('plantuml.js'), 'utf8')) })
  const svg: string = await page.evaluate(async () => {
    type Api = { PlantUML: { renderToString(l: string[], ok: (s: string) => void, fail: (m: string) => void): void } }
    const api = globalThis as unknown as Api
    return new Promise((resolve) => {
      api.PlantUML.renderToString(['@startuml', '!theme plain', 'Alice -> Bob: hi', '@enduml'], resolve, resolve)
    })
  })
  expect(plantumlProblemOf(svg)).toBeNull()
  expect(svg).toContain('Alice')
})
