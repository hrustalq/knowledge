import { join } from 'node:path';
import {
  AcceptLanguageResolver,
  CookieResolver,
  I18nJsonLoader,
  type I18nAsyncOptions,
  type I18nOptionsWithoutResolvers,
  QueryResolver,
} from 'nestjs-i18n';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@knowledge/contracts';

/**
 * One i18n configuration, imported by all three Nest entrypoints (docs/features/18).
 *
 * The catalogs live in src/i18n/{en,ru}/*.json and are copied into dist by the
 * `assets` entry in nest-cli.json, so `import.meta.dirname` points at the
 * catalog root in both `nest start` and `node dist/main` (there is no __dirname
 * here — apps/api is native ESM).
 *
 * Resolution order is deliberate: an explicit ?lang= wins (EventSource cannot
 * set headers, exactly like the ?token= escape hatch in AuthGuard), then the
 * kn_lang cookie, which mirrors users.locale and is therefore the user's actual
 * choice, and only then Accept-Language, which is the browser's default rather
 * than a decision anyone made in this app.
 *
 * users.locale is not resolved here on purpose: nestjs-i18n resolves in
 * middleware, which runs before AuthGuard, so req.principal does not exist yet.
 * The web mirrors the stored preference into the cookie at sign-in, and worker
 * code passes an explicit `lang` from its own frozen column.
 *
 * NOTE `resolvers` and `loader` are declared on the async options object, NOT
 * returned from useFactory: I18nAsyncOptions types the factory result as
 * `I18nOptionsWithoutResolvers`, so anything returned under those two keys is
 * silently dropped and every request falls back to fallbackLanguage.
 */
function i18nOptions(fallbackLanguage?: string): I18nOptionsWithoutResolvers {
  return {
    fallbackLanguage: fallbackLanguage ?? DEFAULT_LOCALE,
    // Treat every region tag as its base language: ru-RU, ru-BY -> ru.
    fallbacks: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [`${l}-*`, l])),
    loaderOptions: {
      path: import.meta.dirname,
      // No chokidar watcher: the worker and the MCP stdio server would keep one
      // open for catalogs that only change on deploy.
      watch: false,
    },
    // Regenerated in dev only: `make api-schema` boots AppModule too, and that
    // must not write into src/ as a side effect of generating the OpenAPI file.
    ...(process.env.NODE_ENV === 'development'
      ? { typesOutputPath: join(process.cwd(), 'src/i18n/i18n.generated.ts') }
      : {}),
  };
}

export const i18nAsyncOptions: I18nAsyncOptions = {
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => i18nOptions(config.get('I18N_DEFAULT_LOCALE')),
  loader: I18nJsonLoader,
  resolvers: [
    { use: QueryResolver, options: ['lang'] },
    { use: CookieResolver, options: ['kn_lang'] },
    AcceptLanguageResolver,
  ],
};
