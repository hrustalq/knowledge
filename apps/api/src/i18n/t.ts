import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { I18nContext, I18nService } from 'nestjs-i18n';
import type { Locale } from '@knowledge/contracts';

/**
 * Ambient translation for throw sites (docs/features/18).
 *
 * nestjs-i18n resolves the request language in middleware and parks it in an
 * AsyncLocalStorage, so `I18nContext.current()` reaches all 178 throw sites
 * without widening a single service signature — which is exactly why services
 * here keep taking ids rather than a locale.
 */
let service: I18nService | undefined;

/**
 * Locale for code paths nestjs-i18n's middleware never touches: the WebSocket
 * gateway (APP_GUARDs and middleware do not run on an upgrade) and BullMQ jobs
 * (no request at all). `withLocale` makes the ambient `t()` — including the one
 * inside services those paths call — answer in the right language.
 */
const forced = new AsyncLocalStorage<Locale>();

/** Run `fn` with `lang` as the ambient language for every nested `t()` call. */
export function withLocale<T>(lang: Locale, fn: () => T): T {
  return forced.run(lang, fn);
}

@Injectable()
export class I18nRegistry implements OnModuleInit {
  constructor(private readonly i18n: I18nService) {}

  onModuleInit(): void {
    service = this.i18n;
  }
}

/**
 * Translate `key` in the current language: an explicit `lang` wins, then a
 * `withLocale` scope, then the HTTP request's resolved language, then the
 * configured default.
 *
 * Interpolation is `{name}`. A fragment that must itself be translated (a
 * status, a role, a subject noun) is translated by a nested `t()` call at the
 * call site rather than glued in as English — Russian needs those declined,
 * not concatenated.
 */
export function t(key: string, args?: Record<string, unknown>, lang?: Locale): string {
  const explicit = lang ?? forced.getStore();
  const ctx = I18nContext.current();
  if (!explicit && ctx) return ctx.t(key, { args }) as string;
  if (service) return service.translate(key, { lang: explicit, args }) as string;
  // Before onModuleInit (or in a bare unit test): the key is a far better
  // diagnostic than an empty string, and never reaches a user.
  return key;
}
