// The kit's half of apps/web/eslint.config.js: copy stays in the `ui` catalogue
// (src/messages), and nothing formats a date or a
// number by the host's locale — a component takes the formatted text or a
// formatter from its caller.
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

const LOCALE_FORMATTING = [
  'error',
  {
    selector: 'CallExpression[callee.property.name=/^toLocale(String|DateString|TimeString)$/]',
    message: 'Take the formatted text (or a formatter) as a prop: a locale-less toLocale*() is a hydration mismatch.',
  },
  {
    selector: "NewExpression[callee.object.name='Intl']",
    message: 'Take the formatted text (or a formatter) as a prop: the app decides the locale.',
  },
]

export default [
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, sourceType: 'module', extraFileExtensions: ['.vue'] },
    },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: { 'vue-i18n': { localeDir: './src/messages/*.json', messageSyntaxVersion: '^11.0.0' } },
    rules: {
      '@intlify/vue-i18n/no-missing-keys': 'error',
      '@intlify/vue-i18n/no-raw-text': [
        'error',
        {
          ignorePattern: '^[\\s\\d.,:;!?·→←—–×/…•|()+\\-#@%&*=<>\\[\\]{}"\'`]*$',
          // Typographic quotes and a keycap: the same in every language.
          ignoreText: ['“', '”', 'Esc'],
          attributes: { '/.+/': ['title', 'aria-label', 'placeholder', 'alt'] },
        },
      ],
      'no-restricted-syntax': LOCALE_FORMATTING,
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    languageOptions: { parser: tseslint.parser, sourceType: 'module' },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: { 'vue-i18n': { localeDir: './src/messages/*.json', messageSyntaxVersion: '^11.0.0' } },
    rules: { '@intlify/vue-i18n/no-missing-keys': 'error', 'no-restricted-syntax': LOCALE_FORMATTING },
  },
]
