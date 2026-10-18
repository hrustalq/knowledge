import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

/**
 * The SP's own signing/decryption key pair for a SAML provider (#75 phase 6),
 * made once when the provider is created. The certificate is self-signed: an
 * IdP pins it from our metadata, so no CA has anything to vouch for.
 *
 * node:crypto makes keys but not certificates, and the certificate is only an
 * envelope for the public key, so the few DER structures it needs are written
 * here rather than pulling in a PKI library. The spec checks the result with
 * Node's own `X509Certificate` parser and signature check.
 */

const CERT_YEARS = 10;
const OID = {
  sha256WithRsa: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
};

const lengthOf = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
/** A DER INTEGER is signed: a leading byte with the top bit set gets a 0x00 in front. */
const int = (bytes: Buffer) => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
/** RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime after. */
const time = (d: Date): Buffer => {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
};

export interface SpKeyPair {
  privateKeyPem: string;
  certPem: string;
}

export function generateSpKeyPair(commonName: string, now = new Date()): SpKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = seq(oid(OID.sha256WithRsa), Buffer.from([0x05, 0x00]));
  const name = seq(tlv(0x31, seq(oid(OID.commonName), tlv(0x0c, Buffer.from(commonName)))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01; // positive and non-zero, as RFC 5280 asks
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + CERT_YEARS);

  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), // v3
    int(serial),
    algorithm,
    name,
    seq(time(now), time(until)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature));
  const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certPem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
  };
}

/**
 * An IdP's signing certificate(s) as an admin pasted them — one PEM, several
 * (a rollover), or bare base64 from a metadata file — as PEM blocks that each
 * parse as X.509. Null when any of it does not.
 */
export function parseCertificates(raw: string): string[] | null {
  const blocks = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
    ?? (raw.trim() ? [`-----BEGIN CERTIFICATE-----\n${raw.replace(/\s+/g, '')}\n-----END CERTIFICATE-----`] : []);
  if (!blocks.length || blocks.length > 5) return null;
  try {
    return blocks.map((b) => new X509Certificate(b).toString().trim());
  } catch {
    return null;
  }
}
