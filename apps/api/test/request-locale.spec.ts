import { describe, expect, it } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { toMeResponse } from '../src/auth/me-response.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { requestedLocale } from '../src/i18n/locale.js';

// #1185: a request that names a language is answered in it — errors and model replies alike.
describe('requestedLocale', () => {
  it('names a language only when the request does, in ?lang= -> kn_lang -> Accept-Language order', () => {
    expect(requestedLocale({ url: '/x?lang=ru', headers: { 'accept-language': 'en' } })).toBe('ru');
    expect(requestedLocale({ headers: { cookie: 'kn_lang=en', 'accept-language': 'ru' } })).toBe('en');
    expect(requestedLocale({ headers: { 'accept-language': 'de;q=1, ru-RU;q=0.8' } })).toBe('ru');
    expect(requestedLocale({ headers: {} })).toBeNull();
    expect(requestedLocale({ headers: { 'accept-language': 'de' } })).toBeNull();
  });

  it('treats a bare wildcard as naming nothing (Node fetch sends it by default)', () => {
    expect(requestedLocale({ headers: { 'accept-language': '*' } })).toBeNull();
    expect(requestedLocale({ headers: { 'accept-language': '*, ru;q=0.5' } })).toBe('ru');
  });
});

describe('AuthGuard request language', () => {
  const stored: Principal = { ...DEV_PRINCIPAL, mode: 'api-key', userId: 'u1', locale: 'ru' };
  const run = async (headers: Record<string, string>, url = '/v1/x') => {
    const req: { url: string; headers: Record<string, string>; principal?: Principal } = {
      url,
      headers: { authorization: 'Bearer kn_test', ...headers },
    };
    const guard = new AuthGuard(
      { getAllAndOverride: () => undefined } as never,
      { resolve: async () => stored, blocksUnverified: () => false } as never,
    );
    const ctx = { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null };
    await guard.canActivate(ctx as never);
    return req.principal!;
  };

  it('answers in the language the request names and keeps the saved one for /v1/me', async () => {
    const p = await run({ 'accept-language': 'en' });
    expect(p.locale).toBe('en');
    expect(p.savedLocale).toBe('ru');
    expect(toMeResponse(p, [], false, false).locale).toBe('ru');
    expect(stored.locale).toBe('ru'); // the resolved principal is copied, never mutated
  });

  it('falls back to the saved language when the request names none', async () => {
    const p = await run({ 'accept-language': '*' });
    expect(p.locale).toBe('ru');
    expect(p.savedLocale).toBeUndefined();
  });
});
