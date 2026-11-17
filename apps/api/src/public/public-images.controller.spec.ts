import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { imageProxyKey } from '@knowledge/contracts/publishing';
import { ImageSigner } from './image-signer.js';
import { PublicImagesController } from './public-images.controller.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const signer = new ImageSigner({ get: () => 'test-key' } as never);
const controller = new PublicImagesController(signer, { get: () => true } as never);

function response() {
  const res = { set: vi.fn(), send: vi.fn() };
  res.set.mockReturnValue(res);
  return res as typeof res & ExpressResponse;
}

// #1146: a reader with no session gets an image only by a URL the API signed.
describe('PublicImagesController', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('serves a URL the page signed, cacheable and inert', async () => {
    const url = imageProxyKey(`${origin}/a.png`)!;
    const sig = signer.signAll(`![chart](${origin}/a.png)`)[url]!;
    const res = response();
    await controller.image(url, sig, res);
    const headers = res.set.mock.calls[0]![0];
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Content-Security-Policy']).toContain('sandbox');
    expect(headers['Cache-Control']).toBe('public, max-age=86400');
    expect(res.send.mock.calls[0]![0]).toEqual(PNG);
  });

  it('refuses an unsigned, tampered or re-pointed URL before fetching anything', async () => {
    const url = imageProxyKey(`${origin}/a.png`)!;
    const sig = signer.sign(url);
    for (const [u, s] of [
      [url, undefined],
      [url, ''],
      [url, sig.replace(/^./, (c) => (c === '0' ? '1' : '0'))],
      [`${origin}/b.png`, sig],
      [undefined, sig],
    ] as const) {
      const res = response();
      await expect(controller.image(u, s, res)).rejects.toBeInstanceOf(ForbiddenException);
      expect(res.send).not.toHaveBeenCalled();
    }
    // Another deployment's key signs differently.
    expect(new ImageSigner({ get: () => 'other' } as never).verify(url, sig)).toBe(false);
  });
});
