// ESLint here exists for one job: keep UI copy in the i18n catalogs (#85,
// docs/features/18-i18n.md). General linting stays with vue-tsc; this config
// deliberately enables nothing else.
//
// Existing violations live in eslint-suppressions.json — a shrink-only
// baseline like `make deps-baseline`: `pnpm lint:i18n-baseline` prunes fixed
// entries, and a NEW violation fails `make verify`. Never re-run
// `--suppress-all` to hide one; translate it.
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

// Symbols and brand names that are the same in every language.
const RAW_TEXT_IGNORE = [
  // punctuation and keycaps
  '·', '→', '←', '—', '–', '−', '×', '/', '/ −', '…', '•', '|', ':', '(', ')', '+', '-', '#', '@', '~', '“', '”', '↵',
  'Esc', 'H', 'J', 'P', 'V',
  // brand, protocol and file names
  'Knowledge', 'MCP', 'GitHub', 'GitLab', 'Markdown', 'DeepSeek', 'GenAPI (gen-api.ru)', 'Streamable HTTP', 'URL', 'SKILL.md',
  // env assignments shown verbatim to operators
  'ASSISTANT_PROVIDER=openai-compatible', 'ASSISTANT_PROVIDER=none',
]


// Dates, numbers, sizes and lists go through lib/format.ts: a locale-less
// `toLocale*()` follows the host (the server, during SSR — a hydration
// mismatch), and a second `new Intl.*` is a second place deciding the locale.
const LOCALE_FORMATTING = [
  'error',
  {
    selector: "CallExpression[callee.property.name=/^toLocale(String|DateString|TimeString)$/]",
    message: 'Use the lib/format.ts wrappers (formatNumber, formatDate, …) — a locale-less toLocale*() is a hydration mismatch.',
  },
  {
    selector: "NewExpression[callee.object.name='Intl']",
    message: 'Add a helper to lib/format.ts instead of building Intl formatters here.',
  },
]

export default [
  // Pre-existing disable comments belong to no configured rule here.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  { ignores: ['dist/**', 'node_modules/**', 'src/api/schema.d.ts', 'src/pages/docs/content/**'] },
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, sourceType: 'module', extraFileExtensions: ['.vue'] },
    },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: {
      'vue-i18n': { localeDir: './src/i18n/messages/*.json', messageSyntaxVersion: '^11.0.0' },
    },
    rules: {
      '@intlify/vue-i18n/no-raw-text': [
        'error',
        {
          ignorePattern: '^[\\s\\d.,:;!?·→←—–×/…•|()+\\-#@%&*=<>\\[\\]{}"\'`]*$',
          ignoreText: RAW_TEXT_IGNORE,
        },
      ],
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-restricted-syntax': LOCALE_FORMATTING,
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
    languageOptions: { parser: tseslint.parser, sourceType: 'module' },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: {
      'vue-i18n': { localeDir: './src/i18n/messages/*.json', messageSyntaxVersion: '^11.0.0' },
    },
    rules: {
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-restricted-syntax': LOCALE_FORMATTING,
    },
  },
  {
    // The one place allowed to build Intl formatters.
    files: ['src/lib/format.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]
