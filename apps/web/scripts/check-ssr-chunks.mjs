#!/usr/bin/env node
/**
 * Evaluates every chunk of the SSR build on its own, each in a fresh module
 * graph (one worker per chunk), and fails if any throws while loading.
 *
 * A route's first server render imports its chunk first, so a chunk that only
 * evaluates when some other chunk happened to load before it is a 500 waiting
 * for the right cold request (#630). Neither typecheck nor the Vite dev server
 * can see it — only the built bundle can. Run at the end of `build:server`.
 */
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { availableParallelism } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const root = resolve(import.meta.dirname, '../dist/server')
const chunks = [
  ...readdirSync(root).filter((f) => f.endsWith('.js')),
  ...readdirSync(join(root, 'assets')).filter((f) => f.endsWith('.js')).map((f) => `assets/${f}`),
]

const evaluate = (file) =>
  new Promise((done) => {
    const url = pathToFileURL(join(root, file)).href
    const worker = new Worker(`import(${JSON.stringify(url)}).then(() => process.exit(0))`, { eval: true })
    worker.once('error', (e) => done({ file, error: e.message }))
    worker.once('exit', (code) => done(code === 0 ? null : { file, error: `exit ${code}` }))
  })

const failures = []
const queue = [...chunks]
await Promise.all(
  Array.from({ length: availableParallelism() }, async () => {
    while (queue.length) {
      const failure = await evaluate(queue.shift())
      if (failure) failures.push(failure)
    }
  }),
)

if (failures.length) {
  for (const f of failures) console.error(`✗ ${f.file}: ${f.error}`)
  console.error(`${failures.length} of ${chunks.length} SSR chunks do not evaluate on their own (#630).`)
  process.exit(1)
}
console.log(`✓ all ${chunks.length} SSR chunks evaluate on their own`)
