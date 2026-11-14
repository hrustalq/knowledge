import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeFetch } from '../src/common/safe-fetch.js';
import { isPrivateAddress } from '../src/common/safe-url.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fe90::1', 'febf::1', 'fec0::1', 'fc00::1', 'fd00::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:a00:1',
    '64:ff9b::7f00:1', '::127.0.0.1',
    // #1110: IETF protocol assignments, benchmarking, multicast, reserved (incl. broadcast)
    '192.0.0.1', '198.18.0.1', '198.19.255.254', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    // #1110: 6to4 and Teredo embed an IPv4 address; IPv6 multicast
    '2002:7f00:1::1', '2002:a9fe:a9fe::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'ff02::1', 'ff05::1:3',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:808:808', '192.0.1.1', '198.20.0.1', '223.255.255.1', '2001:4860:4860::8888', '2003::1'])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('safeFetch', () => {
  let server: Server;
  let other: Server;
  let port: number;
  let otherPort: number;
  const seen: Array<{ url: string; method: string; headers: Record<string, unknown> }> = [];

  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<Server>((resolve) => {
      const s = createServer(handler);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

  beforeAll(async () => {
    const handler: Parameters<typeof createServer>[1] = (req, res) => {
      seen.push({ url: req.url!, method: req.method!, headers: req.headers });
      const to = /^\/to\/(.*)$/.exec(req.url!)?.[1];
      if (to) return void res.writeHead(req.method === 'POST' ? 303 : 302, { location: decodeURIComponent(to) }).end();
      if (req.url === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
      res.end(`ok ${req.url}`);
    };
    server = await listen(handler);
    other = await listen(handler);
    port = (server.address() as AddressInfo).port;
    otherPort = (other.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
    other.close();
  });

  it.each(['localhost', '127.0.0.1', '[::ffff:7f00:1]', '[::ffff:127.0.0.1]'])('refuses to dial %s', async (host) => {
    const before = seen.length;
    await expect(safeFetch(`http://${host}:${port}/x`)).rejects.toThrow();
    expect(seen.length).toBe(before);
  });

  it('follows a redirect and answers with the last hop', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/to/%2Fend`, {}, true);
    expect(await res.text()).toBe('ok /end');
    expect(res.url).toContain('/end');
  });

  it('keeps a credential on its origin and drops it on another', async () => {
    const headers = { 'x-api-key': 's3cret', authorization: 'Bearer t', accept: 'text/plain' };
    seen.length = 0;
    await safeFetch(`http://127.0.0.1:${port}/to/%2Fsame`, { headers }, true);
    expect(seen.at(-1)).toMatchObject({ url: '/same', headers: { 'x-api-key': 's3cret', authorization: 'Bearer t' } });

    const away = encodeURIComponent(`http://127.0.0.1:${otherPort}/away`);
    await safeFetch(`http://127.0.0.1:${port}/to/${away}`, { headers }, true);
    const last = seen.at(-1)!;
    expect(last.url).toBe('/away');
    expect(last.headers).toMatchObject({ accept: 'text/plain' });
    expect(last.headers).not.toHaveProperty('x-api-key');
    expect(last.headers).not.toHaveProperty('authorization');
  });

  it('turns a POST into a GET on a 303, stops on a loop, and leaves manual to the caller', async () => {
    seen.length = 0;
    await safeFetch(`http://127.0.0.1:${port}/to/%2Fafter`, { method: 'POST', body: 'x' }, true);
    expect(seen.at(-1)).toMatchObject({ url: '/after', method: 'GET' });

    await expect(safeFetch(`http://127.0.0.1:${port}/loop`, {}, true)).rejects.toThrow(/too many redirects/);

    const manual = await safeFetch(`http://127.0.0.1:${port}/to/%2Fend`, { redirect: 'manual' }, true);
    expect(manual.status).toBe(302);
  });
});
