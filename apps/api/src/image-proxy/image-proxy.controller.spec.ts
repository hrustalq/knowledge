import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BadGatewayException, BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Response as ExpressResponse } from 'express';
import type { Env } from '../config/env.js';
import { ImageProxyController } from './image-proxy.controller.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function proxy(allowPrivate: boolean) {
  return new ImageProxyController({ get: () => allowPrivate } as unknown as ConfigService<Env, true>);
}

function response() {
  const res = { set: vi.fn(), send: vi.fn() };
  res.set.mockReturnValue(res);
  return res;
}

// #1133: the proxy refuses what is not a public http(s) image and serves the rest inert.
describe('ImageProxyController', () => {
  let server: Server;
  let origin: string;
  const seen: Record<string, string | undefined>[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ cookie: req.headers.cookie, referer: req.headers.referer });
      if (req.url === '/a.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
      if (req.url === '/moved') return res.writeHead(302, { Location: '/a.png' }).end();
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<script>alert(1)</script>');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('refuses a private address unless the deployment allows one', async () => {
    await expect(proxy(false).image(`${origin}/a.png`, response() as unknown as ExpressResponse)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(proxy(false).image('http://169.254.169.254/latest/meta-data', response() as unknown as ExpressResponse)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses anything but an http(s) URL', async () => {
    for (const url of [undefined, 'not a url', 'file:///etc/passwd', 'data:image/png;base64,AAAA']) {
      await expect(proxy(true).image(url, response() as unknown as ExpressResponse)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('serves an image inert, following redirects, and sends the upstream nothing of the reader', async () => {
    const res = response();
    await proxy(true).image(`${origin}/moved`, res as unknown as ExpressResponse);
    const headers = res.set.mock.calls[0][0];
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Content-Security-Policy']).toContain('sandbox');
    expect(headers['Cache-Control']).toBe('private, max-age=86400');
    expect(res.send.mock.calls[0][0]).toEqual(PNG);
    expect(seen.every((h) => !h.cookie && !h.referer)).toBe(true);
  });

  it('refuses a body that is not an image', async () => {
    await expect(proxy(true).image(`${origin}/page`, response() as unknown as ExpressResponse)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
