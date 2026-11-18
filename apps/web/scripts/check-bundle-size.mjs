import { readFileSync, statSync } from 'node:fs'

const root = new URL('../dist/client/', import.meta.url)
const budgets = [
  ['index.html', Number(process.argv[2] ?? 850 * 1024)],
  ['reader.html', 575 * 1024],
]
let failed = false

for (const [entry, budget] of budgets) {
  const html = readFileSync(new URL(entry, root), 'utf8')
  const files = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((match) => match[1]))
  const bytes = [...files].reduce((total, file) => total + statSync(new URL(`.${file}`, root)).size, 0)
  const kib = (bytes / 1024).toFixed(1)
  const limit = (budget / 1024).toFixed(0)
  console.log(`${bytes > budget ? 'FAIL' : 'PASS'} ${entry}: ${kib} KiB / ${limit} KiB initial JS (${files.size} files)`)
  if (bytes > budget) failed = true
}

if (failed) process.exitCode = 1
