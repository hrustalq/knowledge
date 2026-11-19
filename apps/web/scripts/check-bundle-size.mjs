import { readFileSync, statSync } from 'node:fs'

const root = new URL('../dist/client/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', root), 'utf8'))
// The reader's shell loads its page lazily, one per view (#1281), so a reader
// budget is the shell plus that page's static import graph — what a share or a
// site downloads before it hydrates.
const budgets = [
  ['index.html', null, Number(process.argv[2] ?? 850 * 1024)],
  ['reader.html', 'src/modules/reader/pages/SharePage.vue', 400 * 1024],
  ['reader.html', 'src/modules/reader/pages/SitePage.vue', 505 * 1024],
]
let failed = false

function addChunk(key, files) {
  const file = `/${manifest[key].file}`
  if (files.has(file)) return
  files.add(file)
  for (const next of manifest[key].imports ?? []) addChunk(next, files)
}

for (const [entry, page, budget] of budgets) {
  const html = readFileSync(new URL(entry, root), 'utf8')
  const files = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((match) => match[1]))
  if (page) addChunk(page, files)
  const bytes = [...files].reduce((total, file) => total + statSync(new URL(`.${file}`, root)).size, 0)
  const kib = (bytes / 1024).toFixed(1)
  const limit = (budget / 1024).toFixed(0)
  const name = page ? `${entry} + ${page.split('/').pop()}` : entry
  console.log(`${bytes > budget ? 'FAIL' : 'PASS'} ${name}: ${kib} KiB / ${limit} KiB initial JS (${files.size} files)`)
  if (bytes > budget) failed = true
}

if (failed) process.exitCode = 1
