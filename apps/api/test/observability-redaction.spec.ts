import { describe, expect, it } from 'vitest';
import { redactUrl } from '@knowledge/observability';
import { traceMiddleware } from '@knowledge/observability/express';
import { clientIp } from '../src/common/client-ip.js';
import { readCookie } from '../src/common/cookies.js';

// #1112: what a request leaves in the logs, and who it is counted as.

const TOKEN = `kp_${'A'.repeat(43)}`;

describe('redactUrl masks a share token in the path', () => {
  it('masks the API share routes and the web share page', () => {
    expect(redactUrl(`/v1/public/shares/${TOKEN}`)).toBe('/v1/public/shares/kp_[REDACTED]');
    expect(redactUrl(`/v1/public/shares/${TOKEN}/pages/d1?x=1`)).toBe('/v1/public/shares/kp_[REDACTED]/pages/d1?x=1');
    expect(redactUrl(`/api/v1/public/shares/${TOKEN}/unlock`)).toBe('/api/v1/public/shares/kp_[REDACTED]/unlock');
    expect(redactUrl(`/s/${TOKEN}`)).toBe('/s/kp_[REDACTED]');
    expect(redactUrl(`/s/${TOKEN}/doc-1#h`)).toBe('/s/kp_[REDACTED]/doc-1#h');
  });

  it('masks a malformed token too, and leaves other paths alone', () => {
    expect(redactUrl('/s/kp_short')).toBe('/s/kp_[REDACTED]');
    expect(redactUrl('/v1/documents/kp_note')).toBe('/v1/documents/kp_note');
    expect(redactUrl('/settings/sharing')).toBe('/settings/sharing');
  });
});

describe('traceMiddleware takes an inbound X-Request-Id only when it is id-shaped', () => {
  function traceIdFor(header: string | undefined): string {
    const headers: Record<string, string> = {};
    traceMiddleware(
      { method: 'GET', url: '/x', headers: header === undefined ? {} : { 'x-request-id': header } },
      {
        statusCode: 200,
        setHeader: (name: string, value: string) => (headers[name] = value),
        getHeader: () => undefined,
        on: () => undefined,
      },
      () => undefined,
    );
    return headers['x-request-id'];
  }

  it('keeps a UUID and a short token-shaped id', () => {
    expect(traceIdFor('0b9f6a7e-58c4-4c39-9a8b-2a3c4d5e6f70')).toBe('0b9f6a7e-58c4-4c39-9a8b-2a3c4d5e6f70');
    expect(traceIdFor('req_ABC-123_xyz')).toBe('req_ABC-123_xyz');
  });

  it('replaces an oversized, marked-up or too-short id with a fresh UUID', () => {
    for (const forged of ['a'.repeat(65), `<script>alert(1)</script>${'x'.repeat(300)}`, 'short', 'has space id', '']) {
      const id = traceIdFor(forged);
      expect(id).not.toBe(forged);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('clientIp believes the right-most address no internal hop added', () => {
  const req = (peer: string, xff?: string) => ({
    socket: { remoteAddress: peer },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });

  it('ignores a forged left-most entry an appending proxy passed along', () => {
    expect(clientIp(req('10.42.0.7', '6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(req('10.42.0.7', '6.6.6.6, 203.0.113.9, 10.42.0.5'))).toBe('203.0.113.9');
  });

  it('still reads a single forwarded visitor, and a public peer as itself', () => {
    expect(clientIp(req('172.18.0.4', '203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(req('198.51.100.2', '203.0.113.9'))).toBe('198.51.100.2');
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
  });

  it('falls back to the left-most entry when every hop is internal', () => {
    expect(clientIp(req('127.0.0.1', '192.168.1.20, 10.0.0.3'))).toBe('192.168.1.20');
  });
});

describe('readCookie', () => {
  it('returns null for a value that does not decode instead of throwing', () => {
    expect(() => readCookie('kn_token=%E0%A4%A', 'kn_token')).not.toThrow();
    expect(readCookie('kn_token=%E0%A4%A', 'kn_token')).toBeNull();
    expect(readCookie('a=1; kn_token=ks%5Fabc', 'kn_token')).toBe('ks_abc');
  });
});
