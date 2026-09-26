import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { I18nJsonLoader, I18nModule } from 'nestjs-i18n';

/**
 * Worker-side errors are stored (`run.error`, `import_jobs.error`, item
 * `error`, run `warnings`) and shown to the person who started the run, so they
 * are translated at the throw site in the run's frozen locale (#85, feature 18).
 *
 * Two guarantees, checked without infrastructure:
 * 1. Every `error.*` key a worker path throws exists in both catalogs with the
 *    same placeholders — a missing key renders as the key itself.
 * 2. A throw inside `withLocale('ru', …)` or with an explicit `ctx.locale`
 *    comes out in Russian: the ambient `t()` reaches code that has no request.
 */
const SRC = join(import.meta.dirname, '../src');
const { t, withLocale, I18nRegistry } = await import('../src/i18n/t.js');
const { requireConfig } = await import('../src/connectors/adapters/connector.types.js');
const { repoHost } = await import('../src/connectors/adapters/repo-archive.js');

const WORKER_FILES = [
  'workflows/workflow.executors.ts',
  'workflows/workflow-materializer.service.ts',
  'import/import.processor.ts',
  'connectors/connector.processor.ts',
  'connectors/connector-staging.service.ts',
  'agents/agent.processor.ts',
  'assistant/assistant.client.ts',
  'connectors/adapters/connector.types.ts',
  ...readdirSync(join(SRC, 'connectors/adapters'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => `connectors/adapters/${f}`),
];

function catalog(lang: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SRC, `i18n/${lang}/error.json`), 'utf8'));
}

function lookup(root: Record<string, unknown>, path: string): string | undefined {
  let node: unknown = root;
  for (const part of path.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  return typeof node === 'string' ? node : undefined;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('worker error keys', () => {
  const en = catalog('en');
  const ru = catalog('ru');
  const keys = new Set<string>();
  for (const file of new Set(WORKER_FILES)) {
    for (const m of readFileSync(join(SRC, file), 'utf8').matchAll(/\bt\('error\.([\w.]+)'/g)) keys.add(m[1]!);
  }

  it('finds the keys it is meant to check', () => {
    expect(keys.size).toBeGreaterThan(20);
  });

  it.each([...keys])('error.%s exists in en and ru with the same placeholders', (key) => {
    const english = lookup(en, key);
    const russian = lookup(ru, key);
    expect(english, `en: ${key}`).toBeTypeOf('string');
    expect(russian, `ru: ${key}`).toBeTypeOf('string');
    expect(placeholders(russian!)).toEqual(placeholders(english!));
  });
});

describe('worker errors follow the run locale', async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      I18nModule.forRoot({
        fallbackLanguage: 'en',
        loader: I18nJsonLoader,
        loaderOptions: { path: join(SRC, 'i18n'), watch: false },
      }),
    ],
    providers: [I18nRegistry],
  }).compile();
  await moduleRef.init();

  it('translates ambiently inside withLocale (no request, no ctx)', () => {
    expect(() => withLocale('ru', () => requireConfig({}, 'repoUrl'))).toThrow('Не заполнено поле настроек: repoUrl');
    expect(() => withLocale('en', () => requireConfig({}, 'repoUrl'))).toThrow('Missing config field: repoUrl');
  });

  it('adapters translate with the connector’s frozen ctx.locale', () => {
    const ctx = { config: { repoUrl: 'https://github.com/only-owner' }, locale: 'ru' } as never;
    expect(() => repoHost(ctx)).toThrow('URL репозитория должен иметь вид https://host/owner/repo');
  });

  it('interpolates parameters', () => {
    expect(t('error.import.timedOut', { filename: 'a.pdf', seconds: 30 }, 'ru')).toBe(
      'Разбор a.pdf занял больше 30 с и был остановлен',
    );
  });
});
