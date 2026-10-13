import { createSSRApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { DEFAULT_LOCALE, type Locale } from '@knowledge/contracts'
// The reader's own catalog, not the app's: a JSON module shared with the app
// would put both whole app catalogs into the reader's bundle.
import en from './i18n/reader/en.json'
import ruCatalog from './i18n/reader/ru.json'
import SharePage from './pages/public/SharePage.vue'
import SitePage from './pages/public/SitePage.vue'
import SiteWidget from './pages/public/SiteWidget.vue'
import type { PublicReaderState } from './pages/public/reader-state'
import './style.css'

/**
 * The public reader's app (docs/features/43, 44): a share or a published
 * site, picked by the view the server resolved; its own i18n, no router, no
 * Pinia, no query client, no auth guard. Built fresh per
 * render on the server and once on the client, like `createApp()` — and for
 * the same reason the i18n instance is created here and never at module scope.
 */
// English is the key vocabulary; a gap in ru fails vue-tsc, as in i18n/index.ts.
const ru: typeof en = ruCatalog

/** The reader's strings for `locale`, for the few the server needs outside a component. */
export function readerMessages(locale: Locale): (typeof en)['shareReader'] {
  return (locale === 'ru' ? ru : en).shareReader
}

export function siteReaderMessages(locale: Locale): (typeof en)['siteReader'] {
  return (locale === 'ru' ? ru : en).siteReader
}

const isSiteView = (state: PublicReaderState) => state.view.kind === 'site' || state.view.kind === 'site-not-found'

export function createPublicApp(state: PublicReaderState) {
  const root = state.view.kind === 'site-widget' ? SiteWidget : isSiteView(state) ? SitePage : SharePage
  const app = createSSRApp({ render: () => h(root, { state }) })
  app.use(
    createI18n({
      legacy: false,
      locale: state.locale,
      fallbackLocale: DEFAULT_LOCALE,
      missingWarn: false,
      fallbackWarn: false,
      messages: { en, ru },
    }),
  )
  return { app }
}
