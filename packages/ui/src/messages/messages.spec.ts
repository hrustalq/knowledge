import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './en.json'
import ru from './ru.json'

/**
 * The kit owns its strings (#941): every key a file here reads is a `ui.*` key
 * of this catalogue, every key of the catalogue is read, and Russian has
 * exactly the keys English has. An app
 * merges the catalogue into its own vue-i18n instance and never has to know
 * a key.
 *
 * Only string literals are checked, as in the app's own message-keys.spec.ts.
 */
const SRC = join(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(vue|ts)$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [path] : []
  })
}

function leafKeys(node: object, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    value !== null && typeof value === 'object' ? leafKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  )
}

describe('ui message catalogue', () => {
  it('ru has exactly the keys en has', () => {
    expect(leafKeys(ru)).toEqual(leafKeys(en))
  })

  it('the kit reads every key of the catalogue and no other', () => {
    const known = new Set(leafKeys(en))
    // `t('…')`, `keypath="…"`, and a table of keys (`'is': 'ui.filter.operator.is'`).
    const KEY = /(?<![\w$.])\$?(?:t|te|tm)\(\s*(['"])([^'"`\n]+?)\1|keypath="([^"]+)"|(['"])(ui\.[\w.]+)\4/g
    const bad: string[] = []
    const read = new Set<string>()
    let checked = 0
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(KEY)) {
        const key = match[2] ?? match[3] ?? match[5]!
        checked++
        read.add(key)
        if (!known.has(key)) bad.push(`${relative(SRC, file)}  ${key}`)
      }
    }
    expect(checked).toBeGreaterThan(30)
    expect(bad).toEqual([])
    // A removed component takes its copy with it.
    expect([...known].filter((key) => !read.has(key))).toEqual([])
  })
})
