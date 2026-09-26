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
const RAW_TEXT_IGNORE = ['·', '→', '←', '—', '–', '×', '/', '…', '•', '|', ':', '(', ')', '+', '-', '#', '@', 'Esc', 'Knowledge', 'MCP', 'GitHub', 'GitLab', 'Markdown']

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
    },
  },
]
