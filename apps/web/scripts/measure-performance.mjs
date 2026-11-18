import { chromium } from '@playwright/test'
import { performance } from 'node:perf_hooks'

const base = process.env.PERF_BASE_URL ?? 'http://localhost:5175'
const api = process.env.PERF_API_URL ?? 'http://localhost:3000'
const workspaceId = process.env.PERF_WORKSPACE_ID
const projectId = process.env.PERF_PROJECT_ID
const documentId = process.env.PERF_DOCUMENT_ID
const sharePath = process.env.PERF_SHARE_PATH
if (!workspaceId || !projectId || !documentId || !sharePath) {
  throw new Error('Set PERF_WORKSPACE_ID, PERF_PROJECT_ID, PERF_DOCUMENT_ID and PERF_SHARE_PATH')
}
const runs = Number(process.env.PERF_RUNS ?? 3)
const routes = [
  { name: 'documents-graph', path: '/documents', view: 'graph', tab: 1 },
  { name: 'documents-tree', path: '/documents', view: 'tree', tab: 2 },
  { name: 'documents-list', path: '/documents', view: 'list', tab: 0 },
  { name: 'long-document', path: `/documents/${documentId}`, action: 'toc' },
  { name: 'editor', path: `/documents/${documentId}/edit`, action: 'editor' },
  { name: 'search', path: '/search', action: 'search' },
  { name: 'assistant', path: '/assistant', action: 'assistant' },
  { name: 'public-reader', path: sharePath, action: 'toc', public: true },
]
const profiles = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, cpu: 1, network: null },
  { name: 'mobile-390', viewport: { width: 390, height: 844 }, cpu: 4, network: { latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 } },
]
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const round = (value) => value == null ? null : Number(value.toFixed(2))

const member = await import('../dist/server/entry-server.js')
const reader = await import('../dist/server/entry-public.js')
const ssr = {}
for (const route of routes) {
  const render = () => route.public
    ? reader.render(route.path, { locale: 'en', forwardedFor: '127.0.0.1' })
    : member.render(route.path, { workspaceId, projectId, locale: 'en' })
  await render()
  const samples = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    await render()
    samples.push(performance.now() - start)
  }
  ssr[route.name] = round(median(samples))
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
for (const profile of profiles) {
  for (const route of routes) {
    const samples = []
    for (let run = 0; run < runs; run++) {
      const context = await browser.newContext({ viewport: profile.viewport, serviceWorkers: 'block' })
      if (!route.public) {
        await context.addCookies([
          { name: 'kn_ws', value: workspaceId, url: base },
          { name: 'kn_proj', value: projectId, url: base },
        ])
      }
      const page = await context.newPage()
      await page.route(`${base}/api/**`, (route) => route.continue({ url: route.request().url().replace(`${base}/api`, api) }))
      const cdp = await context.newCDPSession(page)
      await cdp.send('Network.enable')
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu })
      if (profile.network) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network })
      const scripts = new Map()
      const bodies = []
      page.on('response', (response) => {
        if (response.request().resourceType() !== 'script' || !response.url().startsWith(base)) return
        bodies.push(response.body().then((body) => scripts.set(response.url(), body.length)).catch(() => undefined))
      })
      await page.addInitScript((view) => {
        if (view) localStorage.setItem('kn_docs_view', view)
        Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' } })
        window.__audit = { lcp: 0, cls: 0, inp: 0 }
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__audit.lcp = entry.startTime
        }).observe({ type: 'largest-contentful-paint', buffered: true })
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__audit.cls += entry.value
        }).observe({ type: 'layout-shift', buffered: true })
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) if (entry.interactionId) window.__audit.inp = Math.max(window.__audit.inp, entry.duration)
        }).observe({ type: 'event', buffered: true, durationThreshold: 16 })
      }, route.view)
      await page.goto(base + route.path, { waitUntil: 'load', timeout: 60_000 })
      await page.waitForFunction(() => performance.getEntriesByName('knowledge:hydration').length > 0, undefined, { timeout: 60_000 })
      await page.waitForTimeout(500)
      if (route.tab != null) await page.getByRole('tab').nth(route.tab).click()
      if (route.action === 'editor') {
        await page.locator('.ProseMirror').first().click()
        await page.keyboard.type('x')
      }
      if (route.action === 'search') {
        const input = page.locator('form[role="search"] input')
        await input.pressSequentially('performance', { delay: 25 })
        await input.press('Enter')
      }
      if (route.action === 'assistant') await page.locator('#chat-input').pressSequentially('Hello', { delay: 40 })
      if (route.action === 'toc') {
        const section = page.getByRole('button', { name: 'Section 2', exact: true })
        const link = page.locator('a[href^="#"]:not([href="#main"]):visible').first()
        if (await section.count()) await section.click()
        else if (await link.count()) await link.click()
        else await page.locator('h1').first().click()
      }
      await page.waitForTimeout(500)
      await Promise.all(bodies)
      const sample = await page.evaluate(() => ({
        ...window.__audit,
        hydration: performance.getEntriesByName('knowledge:hydration').at(-1)?.duration ?? null,
      }))
      if (!sample.lcp || sample.hydration == null) throw new Error(`Incomplete metrics for ${route.name}: ${JSON.stringify(sample)}`)
      samples.push({ ...sample, js: [...scripts.values()].reduce((sum, bytes) => sum + bytes, 0) })
      await context.close()
    }
    results.push({
      route: route.name,
      profile: profile.name,
      lcpMs: round(median(samples.map((sample) => sample.lcp))),
      inpMs: round(median(samples.map((sample) => sample.inp))),
      cls: round(median(samples.map((sample) => sample.cls))),
      hydrationMs: round(median(samples.map((sample) => sample.hydration))),
      jsKiB: round(median(samples.map((sample) => sample.js)) / 1024),
      ssrMs: ssr[route.name],
    })
    console.error(`Measured ${JSON.stringify(results.at(-1))}`)
  }
}
await browser.close()
console.log(JSON.stringify({ base, runs, inpFloorMs: 16, results }, null, 2))
