// The console's catalogue plus the UI kit's (`ui.*`), per language. Both are
// small, so both load with the app — unlike the member app, which splits them
// per locale. English is the key vocabulary: a gap in the Russian catalogue
// fails vue-tsc on `ru` below.
import { createI18n } from 'vue-i18n'
import { DEFAULT_LOCALE } from '@knowledge/contracts'
import enApp from './messages/en.json'
import ruApp from './messages/ru.json'
import enUi from '@knowledge/ui/messages/en.json'
import ruUi from '@knowledge/ui/messages/ru.json'

const en = { ...enApp, ...enUi }
const ru: typeof en = { ...ruApp, ...ruUi }

export function createI18nFor() {
  return createI18n({
    legacy: false,
    locale: DEFAULT_LOCALE,
    missingWarn: false,
    messages: { en, ru },
  })
}
