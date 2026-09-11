// Append a host's missing TLS intermediate to certs/extra-ca.pem.
// Some intranet servers send only their leaf certificate and leave the intermediate to AIA
// fetching — browsers do that, Node does not, so the connector fails with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. Usage: node scripts/ca-add.mjs <hostname>
import { connect } from 'node:tls';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';

const host = process.argv[2];
if (!host) {
  console.error('Usage: node scripts/ca-add.mjs <hostname>');
  process.exit(1);
}

const bundle = 'certs/extra-ca.pem';
const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: false });
socket.setTimeout(15_000, () => {
  console.error(`✖ ${host}: timed out`);
  process.exit(1);
});
socket.on('error', (err) => {
  console.error(`✖ ${host}: ${err.code ?? err.message}`);
  process.exit(1);
});

socket.on('secureConnect', async () => {
  const url = socket.getPeerCertificate(true).infoAccess?.['CA Issuers - URI']?.[0];
  socket.end();
  if (!url) {
    console.error(`✖ ${host}: certificate declares no CA Issuers URI — nothing to fetch`);
    process.exit(1);
  }

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`✖ ${url}: HTTP ${res.status}`);
    process.exit(1);
  }
  const body = Buffer.from(await res.arrayBuffer());
  // The AIA endpoint usually serves DER; PEM passes through untouched.
  const pem = body.includes('-----BEGIN CERTIFICATE-----')
    ? body.toString()
    : `-----BEGIN CERTIFICATE-----\n${body.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;

  mkdirSync('certs', { recursive: true });
  let existing = '';
  try {
    existing = readFileSync(bundle, 'utf8');
  } catch {
    /* first cert in the bundle */
  }
  if (existing.includes(pem.trim())) {
    console.log(`· ${host}: issuer already in ${bundle}`);
    return;
  }
  appendFileSync(bundle, `\n# issuer of ${host}, fetched from ${url}\n${pem}`);
  console.log(`✔ ${host}: issuer appended to ${bundle} — restart dev to pick it up`);
});
