// The member app's lint jobs (apps/web/eslint.config.js), for the console
// (#1236): UI copy stays in the catalogues, and the API is called only through
// the typed client.
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

const RAW_FETCH = {
  selector: "CallExpression[callee.name='fetch'], CallExpression[callee.property.name='fetch'][callee.object.name=/^(window|globalThis|self)$/]",
  message: 'Use the typed client (api.* / apiQueryOptions / fetchApi from @/shared/api/queries).',
}
const settings = { 'vue-i18n': { localeDir: './src/shared/i18n/messages/*.json', messageSyntaxVersion: '^11.0.0' } }

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, sourceType: 'module', extraFileExtensions: ['.vue'] },
    },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings,
    rules: {
      '@intlify/vue-i18n/no-raw-text': [
        'error',
        {
          ignorePattern: '^[\\s\\d.,:;!?·→←—–×/…•|()+\\-#@%&*=<>\\[\\]{}"\'`]*$',
          // The product's working name (PRODUCT.md), the same in every language.
          ignoreText: ['Knowledge'],
          attributes: { '/.+/': ['title', 'aria-label', 'placeholder', 'alt'] },
        },
      ],
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-restricted-syntax': ['error', RAW_FETCH],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    languageOptions: { parser: tseslint.parser, sourceType: 'module' },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings,
    rules: { '@intlify/vue-i18n/no-missing-keys': 'error', 'no-restricted-syntax': ['error', RAW_FETCH] },
  },
  {
    // A module's index.ts is its public surface and nothing else, as in apps/web
    // (docs/architecture/11): named re-exports from the module's own files.
    files: ['src/modules/*/index.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportAllDeclaration', message: 'Name each export: an index never re-exports with `export *`.' },
        {
          selector: 'Program > :not(ExportNamedDeclaration[source])',
          message: 'A module index only re-exports (`export { x } from …`): declare in the module, re-export here.',
        },
      ],
    },
  },
]
