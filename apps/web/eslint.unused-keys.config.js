// Report catalog keys no source file references (#85, finding E). Warning-only
// and run on demand (`pnpm lint:i18n-unused`), not in `make verify`: keys
// resolved dynamically (`activity.action.*`, `notifications.event.*`) show up
// here as false positives, so this is a worklist, not a gate — yet.
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import * as jsoncParser from 'jsonc-eslint-parser'

export default [
  {
    files: ['src/i18n/messages/en.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: {
      'vue-i18n': { localeDir: './src/i18n/messages/*.json', messageSyntaxVersion: '^11.0.0' },
    },
    rules: {
      '@intlify/vue-i18n/no-unused-keys': ['warn', { src: './src', extensions: ['.ts', '.vue'] }],
    },
  },
]
