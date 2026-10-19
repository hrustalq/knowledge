import { createPrivateKey, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { SignedXml } from 'xml-crypto';
import { decryptSecret, encryptSecret, parseKey } from '../src/ai/secret-box.js';
import { generateSpKeyPair, parseCertificates } from '../src/auth/sso/saml-cert.js';
import { identityFromSamlProfile } from '../src/auth/sso/saml-profile.js';
import { API, fakeConfig, identityProvidersHarness, ssoHarness, WS, type Row } from './sso-fakes.js';

/**
 * SAML 2.0 sign-in (#75 phase 6). The IdP is a key pair and `xml-crypto`
 * signing hand-built responses; everything on our side — node-saml's
 * signature, audience, timestamp and InResponseTo checks, the transaction,
 * the replay markers, the fragment code — is the real code.
 */

const ENC_KEY = randomBytes(32).toString('base64');
const IDP = 'https://idp.test/realms/corp';
const idp = generateSpKeyPair('Test IdP');
const intruder = generateSpKeyPair('Intruder');
const sp = generateSpKeyPair('Knowledge SAML SP');

const config = () => fakeConfig({ SETTINGS_ENCRYPTION_KEY: ENC_KEY });

function harness(samlOver: Row = {}) {
  const h = ssoHarness(config());
  const provider = (over: Row = {}) =>
    h.provider({
      kind: 'saml',
      preset: 'generic',
      name: 'Corp SAML',
      config: { idpEntityId: IDP, ssoUrl: 'https://idp.test/sso', idpCert: idp.certPem, spCert: sp.certPem, ...samlOver },
      secretCipher: encryptSecret(sp.privateKeyPem, parseKey(ENC_KEY)),
      groupsClaim: 'groups',
      ...over,
    });
  return { ...h, provider };
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

interface AssertionOpts {
  providerId: string;
  inResponseTo?: string | null;
  nameId?: string;
  nameIdFormat?: string;
  email?: string;
  groups?: string[];
  audience?: string;
  issuer?: string;
  assertionId?: string;
}

function assertionXml(o: AssertionOpts): string {
  const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : '';
  const attr = (name: string, values: string[]) =>
    `<saml:Attribute Name="${name}">${values.map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`;
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${o.assertionId ?? `_a${randomUUID()}`}" Version="2.0" IssueInstant="${iso()}">` +
    `<saml:Issuer>${o.issuer ?? IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'}">${o.nameId ?? 'kc-1'}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(300_000)}" Recipient="${API}/v1/auth/saml/${o.providerId}/acs"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? `${API}/v1/auth/saml/${o.providerId}/metadata`}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso()}" SessionIndex="s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attr('email', [o.email ?? 'ada@corp.example'])}${attr('displayName', ['Ada L'])}${attr('groups', o.groups ?? ['kb-editors'])}</saml:AttributeStatement>` +
    `</saml:Assertion>`
  );
}

/** Sign the element with the given ID, enveloped, the way IdPs do. */
function sign(xml: string, id: string, key = idp): string {
  const sig = new SignedXml({ privateKey: key.privateKeyPem, publicCert: key.certPem });
  sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  sig.addReference({
    xpath: `//*[@ID='${id}']`,
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(xml, { location: { reference: `//*[@ID='${id}']/*[local-name(.)='Issuer']`, action: 'after' } });
  return sig.getSignedXml();
}

function responseXml(inner: string, o: { providerId: string; inResponseTo?: string | null }): string {
  const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : '';
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID()}" Version="2.0" IssueInstant="${iso()}" Destination="${API}/v1/auth/saml/${o.providerId}/acs"${irt}>` +
    `<saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    inner +
    `</samlp:Response>`
  );
}

/** A response with a signed assertion — the common Entra shape. */
function signedResponse(o: AssertionOpts, key = idp): string {
  const id = o.assertionId ?? `_a${randomUUID()}`;
  return Buffer.from(responseXml(sign(assertionXml({ ...o, assertionId: id }), id, key), o)).toString('base64');
}

/** The browser's first leg: our redirect to the IdP, and the AuthnRequest id and RelayState in it. */
async function start(h: ReturnType<typeof harness>, providerId: string, returnTo = '/documents/x') {
  const url = new URL(await h.sso.samlStart(providerId, returnTo));
  expect(url.origin + url.pathname).toBe('https://idp.test/sso');
  expect(url.searchParams.get('SigAlg')).toBe('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
  expect(url.searchParams.get('Signature')).toBeTruthy();
  const request = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
  return { requestId: request.match(/ ID="([^"]+)"/)![1], relayState: url.searchParams.get('RelayState')!, request };
}

const meta = { ip: '203.0.113.9', userAgent: 'Browser/1' };
const codeOf = (redirect: string) => redirect.match(/\/auth\/sso\/complete#code=(.+)$/)?.[1] ?? null;
const errorOf = (redirect: string) => new URL(redirect).searchParams.get('error');

describe('SAML sign-in, SP-initiated', () => {
  it('signs the AuthnRequest, accepts a signed assertion for it, JIT-creates the account and opens a saml session', async () => {
    const h = harness();
    const p = h.provider();
    const { requestId, relayState, request } = await start(h, p.id);
    expect(request).toContain(`AssertionConsumerServiceURL="${API}/v1/auth/saml/${p.id}/acs"`);

    const redirect = await h.sso.samlAcs(p.id, { SAMLResponse: signedResponse({ providerId: p.id, inResponseTo: requestId }), RelayState: relayState }, meta);
    const code = codeOf(redirect);
    expect(code).toBeTruthy();
    expect(h.db.users[0]).toMatchObject({ email: 'ada@corp.example', displayName: 'Ada L', passwordHash: null });
    expect(h.db.identities[0]).toMatchObject({ providerId: p.id, subject: 'kc-1' });

    const res = await h.sso.exchange(decodeURIComponent(code!), meta);
    expect(res.returnTo).toBe('/documents/x');
    expect(res.me.authMethod).toBe('saml');
    expect(h.sessions.create).toHaveBeenCalledWith(h.db.users[0].id, expect.objectContaining({ authMethod: 'saml', providerId: p.id }));
  });

  it('accepts a response whose Response element is the signed one (the Keycloak default)', async () => {
    const h = harness();
    const p = h.provider();
    const { requestId, relayState } = await start(h, p.id);
    const rid = `_r${randomUUID()}`;
    const xml = responseXml(assertionXml({ providerId: p.id, inResponseTo: requestId }), { providerId: p.id, inResponseTo: requestId }).replace(/ID="_r[^"]+"/, `ID="${rid}"`);
    const signed = Buffer.from(sign(xml, rid)).toString('base64');
    expect(codeOf(await h.sso.samlAcs(p.id, { SAMLResponse: signed, RelayState: relayState }, meta))).toBeTruthy();
  });

  it.each([
    ['unsigned', (o: AssertionOpts) => Buffer.from(responseXml(assertionXml(o), o)).toString('base64'), /signature/i],
    ['signed by a key that is not pinned', (o: AssertionOpts) => signedResponse(o, intruder), /signature/i],
    ['for another audience', (o: AssertionOpts) => signedResponse({ ...o, audience: 'https://other.example/sp' }), /audience/i],
    ['from another issuer', (o: AssertionOpts) => signedResponse({ ...o, issuer: 'https://evil.example' }), /issuer/i],
    ['answering a request we did not send', (o: AssertionOpts) => signedResponse({ ...o, inResponseTo: '_not-ours' }), /InResponseTo/],
  ])('refuses a response %s', async (_label, build, reason) => {
    const h = harness();
    const p = h.provider();
    const { requestId, relayState } = await start(h, p.id);
    const redirect = await h.sso.samlAcs(p.id, { SAMLResponse: build({ providerId: p.id, inResponseTo: requestId }), RelayState: relayState }, meta);
    expect(errorOf(redirect)).toBe('id-token-invalid');
    expect(h.db.users).toHaveLength(0);
    expect(h.failures().at(-1)).toMatchObject({ params: { method: 'saml', error: 'id-token-invalid' }, error: expect.stringMatching(reason) });
  });

  it('refuses the same response posted twice', async () => {
    const h = harness();
    const p = h.provider();
    const { requestId, relayState } = await start(h, p.id);
    const body = { SAMLResponse: signedResponse({ providerId: p.id, inResponseTo: requestId }), RelayState: relayState };
    expect(codeOf(await h.sso.samlAcs(p.id, body, meta))).toBeTruthy();
    expect(errorOf(await h.sso.samlAcs(p.id, body, meta))).toBe('invalid-state');
    expect(h.failures().at(-1)).toMatchObject({ error: 'state replayed' });
  });

  it('refuses a signature-wrapped response: a forged assertion carrying the genuine signed one inside it', async () => {
    const h = harness();
    const p = h.provider();
    const { requestId, relayState } = await start(h, p.id);
    const genuineId = `_a${randomUUID()}`;
    const genuine = sign(assertionXml({ providerId: p.id, inResponseTo: requestId, assertionId: genuineId }), genuineId);
    // XSW: the forged assertion names eve; the signature still verifies over the genuine one, now hidden in Advice.
    const forged = assertionXml({ providerId: p.id, inResponseTo: requestId, nameId: 'eve', email: 'eve@corp.example', assertionId: genuineId })
      .replace('<saml:Subject>', `<saml:Advice>${genuine.replace(/^<saml:Assertion xmlns:saml="[^"]+"/, '<saml:Assertion')}</saml:Advice><saml:Subject>`)
      .replace(`ID="${genuineId}"`, 'ID="_forged"');
    const body = { SAMLResponse: Buffer.from(responseXml(forged, { providerId: p.id, inResponseTo: requestId })).toString('base64'), RelayState: relayState };
    expect(errorOf(await h.sso.samlAcs(p.id, body, meta))).toBe('id-token-invalid');
    expect(h.db.users).toHaveLength(0);
  });

  it('a disabled provider starts nothing and accepts nothing', async () => {
    const h = harness();
    const p = h.provider({ enabled: false });
    expect(errorOf(await h.sso.samlStart(p.id, '/documents'))).toBe('failed');
    expect(errorOf(await h.sso.samlAcs(p.id, { SAMLResponse: 'x' }, meta))).toBe('failed');
  });
});

describe('SAML sign-in, IdP-initiated', () => {
  it('is refused unless the provider allows it', async () => {
    const h = harness();
    const p = h.provider();
    expect(errorOf(await h.sso.samlAcs(p.id, { SAMLResponse: signedResponse({ providerId: p.id }) }, meta))).toBe('invalid-state');
    expect(h.failures().at(-1)).toMatchObject({ error: 'unsolicited response' });
  });

  it('when allowed, signs in once per assertion', async () => {
    const h = harness({ allowIdpInitiated: true });
    const p = h.provider();
    const body = { SAMLResponse: signedResponse({ providerId: p.id }), RelayState: 'portal-tile' };
    const code = codeOf(await h.sso.samlAcs(p.id, body, meta));
    expect(code).toBeTruthy();
    expect((await h.sso.exchange(decodeURIComponent(code!), meta)).returnTo).toBe('/documents');
    expect(errorOf(await h.sso.samlAcs(p.id, body, meta))).toBe('invalid-state');
    expect(h.failures().at(-1)).toMatchObject({ error: 'assertion replayed' });
  });

  it('a solicited response cannot be replayed as an unsolicited one by stripping its RelayState', async () => {
    const h = harness({ allowIdpInitiated: true });
    const p = h.provider();
    const { requestId, relayState } = await start(h, p.id);
    const SAMLResponse = signedResponse({ providerId: p.id, inResponseTo: requestId });
    expect(codeOf(await h.sso.samlAcs(p.id, { SAMLResponse, RelayState: relayState }, meta))).toBeTruthy();
    expect(codeOf(await h.sso.samlAcs(p.id, { SAMLResponse }, meta))).toBeNull();
    expect(h.db.users).toHaveLength(1);
  });
});

describe('SAML profile mapping', () => {
  const opts = { emailAttribute: null, nameAttribute: null, groupsAttribute: 'groups' };

  it('takes the address from the usual attribute names, else from an email-format NameID', () => {
    const entra = identityFromSamlProfile(
      { nameID: 'x1', attributes: { 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'Ada@Corp.Example' } },
      opts,
    );
    expect(entra).toMatchObject({ ok: true, identity: { email: 'ada@corp.example', emailVerified: true } });
    const nameId = identityFromSamlProfile({ nameID: 'ada@corp.example', nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' }, opts);
    expect(nameId).toMatchObject({ ok: true, identity: { email: 'ada@corp.example' } });
    expect(identityFromSamlProfile({ nameID: 'x1' }, opts)).toMatchObject({ ok: true, identity: { email: null, emailVerified: false } });
  });

  it('refuses a transient NameID, which would be a new person at every sign-in', () => {
    expect(identityFromSamlProfile({ nameID: 'abc', nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient' }, opts)).toMatchObject({
      ok: false,
      error: 'id-token-invalid',
    });
  });

  it('notes an Entra groups overage instead of reading it as no groups', () => {
    const r = identityFromSamlProfile({ nameID: 'x', attributes: { 'http://schemas.microsoft.com/claims/groups.link': 'https://graph' } }, opts);
    expect(r).toMatchObject({ ok: true, identity: { groups: [], notes: ['groups-overage'] } });
  });
});

describe('SAML provider setup', () => {
  // Private addresses off, as in production: an http SSO URL is refused.
  const providers = () => identityProvidersHarness(fakeConfig({ SETTINGS_ENCRYPTION_KEY: ENC_KEY, AUTH_SSO_ALLOW_PRIVATE_URLS: false }));
  const admin = { userId: 'u1', isAdmin: false } as never;
  const body = { kind: 'saml' as const, name: 'Corp', idpEntityId: IDP, ssoUrl: 'https://idp.test/sso', idpCert: idp.certPem };

  it('generates the SP key pair on create; the view carries our endpoints and never the key', async () => {
    const { svc, saml, rows } = providers();
    const view = await svc.create(WS, body, admin);
    expect(view.saml).toMatchObject({ idpEntityId: IDP, entityId: `${API}/v1/auth/saml/${view.id}/metadata`, allowIdpInitiated: false });
    expect(view.redirectUri).toBe(`${API}/v1/auth/saml/${view.id}/acs`);
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE-----\nMII[\s\S]*Knowledge/);

    const row = rows[0];
    const cert = new X509Certificate(row.config.spCert);
    expect(cert.verify(cert.publicKey)).toBe(true);
    const metadata = saml.metadata(row as never);
    expect(metadata).toContain(`entityID="${API}/v1/auth/saml/${row.id}/metadata"`);
    expect(metadata).toContain(`Location="${API}/v1/auth/saml/${row.id}/acs"`);
    expect(metadata).toContain(row.config.spCert.split('\n')[1]);
    expect(saml.test(row as never)).toMatchObject({ ok: true, error: null });

    // A stray clientSecret must not overwrite the SP key, and the SP certificate survives an edit.
    const { secretCipher, config: { spCert } } = row;
    await svc.update(WS, row.id, { clientSecret: 'nope', idpEntityId: 'https://idp.test/other' }, admin);
    expect(row.secretCipher).toBe(secretCipher);
    expect(row.config).toMatchObject({ idpEntityId: 'https://idp.test/other', spCert });
    expect(createPrivateKey(decryptSecret(row.secretCipher, parseKey(ENC_KEY))!).asymmetricKeyType).toBe('rsa');
  });

  it.each([
    ['a missing entity ID', { idpEntityId: '' }, 'error.sso.idpEntityIdRequired'],
    ['a plain-http SSO URL', { ssoUrl: 'http://idp.test/sso' }, 'error.sso.ssoUrlInvalid'],
    ['a certificate that is not one', { idpCert: 'MIIBogus' }, 'error.sso.idpCertInvalid'],
  ])('refuses %s', async (_l, over, key) => {
    const { svc } = providers();
    await expect(svc.create(WS, { ...body, ...over }, admin)).rejects.toThrow(BadRequestException);
    await expect(svc.create(WS, { ...body, ...over }, admin)).rejects.toThrow(key);
  });

  it('reads a pasted certificate with or without its PEM armour, and a rollover pair', () => {
    const bare = idp.certPem.replace(/-----[^-]+-----/g, '');
    expect(parseCertificates(bare)).toHaveLength(1);
    expect(parseCertificates(idp.certPem + intruder.certPem)).toHaveLength(2);
    expect(parseCertificates('not a cert')).toBeNull();
  });
});
