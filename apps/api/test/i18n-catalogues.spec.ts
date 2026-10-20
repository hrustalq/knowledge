import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * API message catalogues (docs/features/18). What is pinned:
 * - every `src/i18n/en/*.json` has a ru twin with the same keys and the same
 *   `{placeholders}` — a key added to one language alone would reach the other
 *   as a raw key, since `t()` is untyped and `i18n.generated.ts` is dev-only;
 * - every static `t('ns.key')` literal in `src` resolves in en (and so, by the
 *   first rule, in ru). Dynamic keys are out of reach on purpose.
 *
 * Plural forms differ by language (en `one/other`, ru `one/few/many/other`),
 * so plural siblings collapse to their parent key, and their placeholders are
 * compared as a union: ru `one` covers 21 and must print `{count}` where en's
 * `one` may spell it out.
 */
const SRC = join(import.meta.dirname, '../src');
const I18N = join(SRC, 'i18n');
const PLURAL = /\.(zero|one|two|few|many|other)$/;

type Catalogue = Map<string, Set<string>>;

const leaves = (node: unknown, prefix = ''): [string, string][] =>
  typeof node === 'string'
    ? [[prefix, node]]
    : Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));

/** Collapsed key → the union of the placeholders its message(s) use. */
function read(lang: string, file: string): Catalogue {
  const catalogue: Catalogue = new Map();
  for (const [key, message] of leaves(JSON.parse(readFileSync(join(I18N, lang, file), 'utf8')))) {
    const collapsed = key.replace(PLURAL, '');
    const names = catalogue.get(collapsed) ?? new Set<string>();
    for (const m of message.matchAll(/\{(\w+)\}/g)) names.add(m[1]!);
    catalogue.set(collapsed, names);
  }
  return catalogue;
}

const files = readdirSync(join(I18N, 'en')).filter((f) => f.endsWith('.json'));

describe('i18n catalogues — en/ru parity', () => {
  it('ru has exactly the en files', () => {
    expect(readdirSync(join(I18N, 'ru')).filter((f) => f.endsWith('.json')).sort()).toEqual([...files].sort());
  });

  it.each(files)('%s: same keys and placeholders in en and ru', (file) => {
    const en = read('en', file);
    const ru = read('ru', file);
    expect([...ru.keys()].filter((k) => !en.has(k)), 'keys only in ru').toEqual([]);
    expect([...en.keys()].filter((k) => !ru.has(k)), 'keys only in en').toEqual([]);
    const mismatched = [...en]
      .filter(([key, names]) => ru.has(key) && [...names].sort().join() !== [...ru.get(key)!].sort().join())
      .map(([key, names]) => `${key}: en {${[...names].sort().join(', ')}} ≠ ru {${[...ru.get(key)!].sort().join(', ')}}`);
    expect(mismatched, 'placeholders differ').toEqual([]);
  });
});

describe('i18n catalogues — static t() keys in src', () => {
  const known = new Set<string>();
  for (const file of files) {
    const ns = file.replace(/\.json$/, '');
    for (const [key] of leaves(JSON.parse(readFileSync(join(I18N, 'en', file), 'utf8')))) {
      known.add(`${ns}.${key}`);
      known.add(`${ns}.${key.replace(PLURAL, '')}`);
    }
  }

  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    );

  // `t('error.x.y'` / `ctx.t("…"` / `` t(`…` `` with no interpolation — a
  // dotted literal as the first argument. Anything computed is skipped.
  const STATIC_KEY = /\bt\(\s*(['"`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g;

  it('every literal key resolves in en', () => {
    const literals = sources(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(STATIC_KEY)].map((m) => ({ file: relative(SRC, file), key: m[2]! })),
    );
    // Guards the scanner itself: a regex that matched nothing would pass forever.
    expect(literals.length).toBeGreaterThan(500);
    expect(literals.filter(({ key }) => !known.has(key)).map(({ file, key }) => `${file}: ${key}`)).toEqual([]);
  });
});
