import { I18nContext } from 'nestjs-i18n';
import { DEFAULT_LOCALE, isLocale, parseAcceptLanguage, type Locale } from '@knowledge/contracts';

/**
 * Narrow a stored `locale` column (a plain TEXT) to a supported Locale.
 *
 * The column is TEXT rather than an enum so adding a language is a catalog
 * change and not a migration; the cost is that rows can outlive the language
 * they name (a locale removed from SUPPORTED_LOCALES, a hand-edited row), and
 * those must degrade to English rather than reach nestjs-i18n as an unknown tag.
 */
export function asLocale(value: string | null | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * Resolve a locale from a raw upgrade/HTTP request, mirroring the resolver
 * order nestjs-i18n uses for normal routes (?lang= -> kn_lang cookie ->
 * Accept-Language). The WebSocket gateway needs this because middleware never
 * runs on an upgrade, so there is no I18nContext to read.
 */
export function localeFromRequest(req: {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}): Locale {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query = url.searchParams.get('lang');
  if (isLocale(query)) return query;

  const rawCookie = req.headers['cookie'];
  const cookie = Array.isArray(rawCookie) ? rawCookie.join('; ') : rawCookie;
  for (const part of cookie?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === 'kn_lang') {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      if (isLocale(value)) return value;
    }
  }

  const raw = req.headers['accept-language'];
  return parseAcceptLanguage(Array.isArray(raw) ? raw[0] : raw) ?? DEFAULT_LOCALE;
}

/**
 * The language the current HTTP request resolved to, for code that must put a
 * locale into a value (an AiCallContext) rather than just translate a string.
 * Falls back to the default outside a request — worker paths pass their own.
 */
export function currentLocale(): Locale {
  return asLocale(I18nContext.current()?.lang);
}
