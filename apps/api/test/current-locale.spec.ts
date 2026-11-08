import { describe, expect, it } from 'vitest';
import { currentLocale, withLocale } from '../src/i18n/t.js';
import { localeFromRequest } from '../src/i18n/locale.js';

// #814: the copy in locale.ts read only the request, so a worker's withLocale was ignored.
describe('currentLocale', () => {
  it('honours withLocale with no request', () => {
    expect(withLocale('ru', () => currentLocale())).toBe('ru');
    expect(currentLocale()).toBe('en');
  });
});

describe('localeFromRequest', () => {
  it('reads kn_lang from the cookie header', () => {
    expect(localeFromRequest({ headers: { cookie: 'a=1; kn_lang=ru' } })).toBe('ru');
    expect(localeFromRequest({ headers: { cookie: 'kn_lang=xx', 'accept-language': 'ru' } })).toBe('ru');
    expect(localeFromRequest({ headers: {} })).toBe('en');
  });
});
