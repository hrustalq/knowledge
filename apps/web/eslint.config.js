// ESLint here exists for two jobs: keep UI copy in the i18n catalogs (#85,
// docs/features/18-i18n.md), and keep API calls on the one typed client (#472).
// General linting stays with vue-tsc; this config deliberately enables nothing
// else.
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
  // example names in placeholders
  'Jira', 'DeepSeek prod', 'Authorization',
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

// One HTTP client (#472): reads go through the generated client and the query
// cache, so they are typed, deduped and reached by live invalidation. A raw
// fetch is allowed only in RAW_FETCH_OK, each with a comment saying why.
const RAW_FETCH = [
  {
    selector: "CallExpression[callee.name='fetch'], CallExpression[callee.property.name='fetch'][callee.object.name=/^(window|globalThis|self)$/]",
    message: 'Use the generated client (api.* / fetchApi / apiQueryOptions from @/api/queries). Raw fetch is allowlisted in eslint.config.js only where XHR cannot do the job.',
  },
]
const RAW_FETCH_OK = [
  'src/lib/assistant-stream.ts', // a streamed response body
  'src/lib/use-page-view.ts', // a keepalive beacon that outlives the tab
  'src/components/api-reference/ApiTryConsole.vue', // try-it: the request is the reader's own
  'src/components/api-reference/ApiTestRun.vue', // the same, for a suite run in the browser
  'src/entry-public.ts', // the public SSR entry: no member client, no credential
  'src/pages/public/**',
  'src/components/public/**',
]

// The app's catalogs, and the public reader's own small one (docs/features/43):
// kept apart so a reader's bundle never carries the app's whole catalog.
const I18N_LOCALE_DIR = ['./src/i18n/messages/*.json', './src/i18n/reader/*.json']

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
      'vue-i18n': { localeDir: I18N_LOCALE_DIR, messageSyntaxVersion: '^11.0.0' },
    },
    rules: {
      '@intlify/vue-i18n/no-raw-text': [
        'error',
        {
          // Punctuation-only, or an example value in a placeholder: an address,
          // a URL, a slug or an entity key (`service:identity`) — the same in
          // every language (#85 keeps them English on purpose).
          ignorePattern:
            '^(?:[\\s\\d.,:;!?·→←—–×/…•|()+\\-#@%&*=<>\\[\\]{}"\'`]*|\\S+@example\\.com|https?://\\S+|[a-z0-9.-]+\\.example\\.com|[a-z]+(?:[-:][a-z0-9-]+)+|[a-z]+(?:, [a-z]+)+)$',
          ignoreText: RAW_TEXT_IGNORE,
          // Static attributes a reader or a screen reader sees.
          attributes: { '/.+/': ['title', 'aria-label', 'placeholder', 'alt'] },
        },
      ],
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-restricted-syntax': [...LOCALE_FORMATTING, ...RAW_FETCH],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
    languageOptions: { parser: tseslint.parser, sourceType: 'module' },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: {
      'vue-i18n': { localeDir: I18N_LOCALE_DIR, messageSyntaxVersion: '^11.0.0' },
    },
    rules: {
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-restricted-syntax': [...LOCALE_FORMATTING, ...RAW_FETCH],
    },
  },
  {
    files: RAW_FETCH_OK,
    rules: { 'no-restricted-syntax': LOCALE_FORMATTING },
  },
  {
    // The one place allowed to build Intl formatters.
    files: ['src/lib/format.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]
