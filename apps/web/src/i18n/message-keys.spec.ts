import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './messages/en.json'

/**
 * Every static `t('…')` key in the web source must resolve to a message in
 * `en.json`.
 *
 * `vue-tsc` does not check key strings, and with `missingWarn: false` a typo
 * renders the raw key in front of the user (`t('cancel')` showed "cancel" on a
 * button for both languages — #85). `ru.json` is already typed against
 * `en.json`, so checking against English covers both catalogs.
 *
 * Only string literals are checked: a key built at runtime (template literal,
 * variable) cannot be resolved statically and is the caller's responsibility.
 */
const SRC = join(import.meta.dirname, '..')

// `t(`, `$t(`, `te(`, `tm(` — but not `emit(`, `split(`, or `x.t(` on some other object.
const CALL = /(?<![\w$.])\$?(?:t|te|tm)\(\s*(['"])([^'"`\n]+?)\1/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    if (!/\.(vue|ts)$/.test(entry.name)) return []
    if (/\.(spec|d)\.ts$/.test(entry.name)) return []
    return [path]
  })
}

function resolves(key: string): boolean {
  let node: unknown = en
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return false
    node = (node as Record<string, unknown>)[part]
  }
  return node !== undefined
}

describe('web i18n message keys', () => {
  it('every static t() key exists in en.json', () => {
    const missing: string[] = []
    let checked = 0
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(CALL)) {
        const key = match[2]!
        checked++
        if (!resolves(key)) {
          const line = text.slice(0, match.index).split('\n').length
          missing.push(`${relative(SRC, file)}:${line}  ${key}`)
        }
      }
    }
    expect(checked).toBeGreaterThan(500)
    expect(missing).toEqual([])
  })
})
