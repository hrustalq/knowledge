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

  /**
   * The reverse: every catalog message is reachable from the source, so a
   * removed screen takes its copy with it (#85, finding E).
   *
   * A key counts as referenced when it appears as a quoted literal anywhere —
   * which also covers maps that hold keys (`RUN_STATUS_LABEL`) and
   * `<i18n-t keypath>` — or when it sits under a prefix built at runtime:
   * `` `activity.action.${x}` `` or `labelFor(t, 'category', x)`. An unused key
   * is deleted from both catalogs, never allowlisted here.
   */
  it('every en.json key is referenced from the source', () => {
    const source = sourceFiles(SRC)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    const literals = new Set(Array.from(source.matchAll(/['"`]([a-zA-Z][\w-]*(?:\.[\w-]+)+)['"`]/g), (m) => m[1]!))
    const prefixes = [
      ...Array.from(source.matchAll(/`([a-zA-Z][\w-]*(?:\.[\w-]+)*\.?)\$\{/g), (m) => m[1]!),
      ...Array.from(source.matchAll(/['"]([a-zA-Z][\w-]*(?:\.[\w-]+)*\.)['"]\s*\+/g), (m) => m[1]!),
      ...Array.from(source.matchAll(/labelFor\([^,]*,\s*'([^']+)'/g), (m) => `${m[1]!}.`),
    ]

    const unused = leafKeys(en).filter(
      (key) =>
        !literals.has(key) &&
        !prefixes.some((prefix) => key.startsWith(prefix)) &&
        // `tm('a.b')` / `rt()` read a whole subtree
        !Array.from(literals).some((literal) => key.startsWith(`${literal}.`)),
    )
    expect(unused).toEqual([])
  })
})

function leafKeys(node: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? leafKeys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  )
}
