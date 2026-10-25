import { describe, expect, it, vi } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { CachePolicy, HttpCacheInterceptor, etagMatches, notModified } from '../src/common/http-cache.js';
import { DocumentsController } from '../src/documents/documents.controller.js';

function response() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headers,
    setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
    vary(field: string) {
      headers.vary = headers.vary ? `${headers.vary}, ${field}` : field;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
  };
  return res;
}

function run(method: string, handler: object = () => undefined, cls: object = class {}) {
  const res = response();
  const ctx = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ method }), getResponse: () => res }),
  };
  return lastValueFrom(new HttpCacheInterceptor(new Reflector()).intercept(ctx as never, { handle: () => of(null) })).then(
    () => res.headers,
  );
}

describe('Cache-Control on every response (#472)', () => {
  it('an authenticated GET revalidates and varies on who asks; a write is never stored', async () => {
    expect(await run('GET')).toEqual({ 'cache-control': 'private, no-cache', vary: 'Authorization, Cookie, Accept-Language' });
    expect(await run('POST')).toEqual({ 'cache-control': 'no-store' });
  });

  it('a controller marked no-store keeps its GETs out of every cache', async () => {
    @CachePolicy('no-store')
    class Sessions {}
    expect(await run('GET', () => undefined, Sessions)).toEqual({ 'cache-control': 'no-store' });
  });

  it('nothing authenticated is ever public or shared', async () => {
    for (const m of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
      const cc = (await run(m))['cache-control'];
      expect(cc).not.toMatch(/public|s-maxage/);
    }
  });
});

describe('conditional GET', () => {
  it('matches an ETag the way RFC 9110 compares them', () => {
    expect(etagMatches(undefined, '"a"')).toBe(false);
    expect(etagMatches('W/"a", "b"', '"a"')).toBe(true);
    expect(etagMatches('*', '"a"')).toBe(true);
    expect(etagMatches('"b"', '"a"')).toBe(false);
  });

  it('the language is part of the validator: an English 304 never confirms a Russian body', () => {
    const en = response();
    notModified({ headers: { 'accept-language': 'en' } } as never, en as never, 'v1');
    const ru = response();
    expect(notModified({ headers: { 'accept-language': 'ru', 'if-none-match': en.headers.etag } } as never, ru as never, 'v1')).toBe(false);
  });

  it('an unchanged page is a 304 without the graph read', async () => {
    const head = { document: { documentId: 'd1', workspaceId: 'w1' }, revision: { revisionId: 'r1', status: 'indexed' } };
    const documents = { getDocumentHead: vi.fn().mockResolvedValue(head), withChunks: vi.fn().mockResolvedValue({ ...head, chunks: [] }) };
    const stub = {} as never;
    const controller = new (DocumentsController as unknown as new (...a: unknown[]) => DocumentsController)(documents, ...Array(20).fill(stub));

    const first = response();
    await controller.get('d1', { headers: {} } as never, first as never);
    expect(documents.withChunks).toHaveBeenCalledTimes(1);

    const second = response();
    const body = await controller.get('d1', { headers: { 'if-none-match': first.headers.etag } } as never, second as never);
    expect(body).toBeUndefined();
    expect(second.statusCode).toBe(304);
    expect(documents.withChunks).toHaveBeenCalledTimes(1);

    head.revision.status = 'failed';
    const third = response();
    await controller.get('d1', { headers: { 'if-none-match': first.headers.etag } } as never, third as never);
    expect(third.statusCode).toBe(200);
  });
});
