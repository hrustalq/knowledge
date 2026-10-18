import { HttpStatus } from '@nestjs/common';
import { t } from '../i18n/t.js';
import { ScimError } from './scim-errors.js';
import { scimBoolean } from './scim-patch.js';

/**
 * SCIM resource shapes (RFC 7643): reading a client's user document into the
 * fields this server acts on, and rendering users, groups, list pages and the
 * discovery documents back.
 *
 * A rendered user is what the client last said (`scim_users.raw`) with the
 * server-owned attributes laid over it. Showing the client its own values is
 * what keeps Entra and Okta from "correcting" an attribute on every cycle
 * when this workspace may not rewrite the global account (see ScimService).
 */

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalidValue = (detail: string) => new ScimError(HttpStatus.BAD_REQUEST, detail, 'invalidValue');

/** Attribute lookup is case-insensitive (RFC 7643 §2.1). */
function get(doc: Doc, attr: string): unknown {
  const key = Object.keys(doc).find((k) => k.toLowerCase() === attr.toLowerCase());
  return key === undefined ? undefined : doc[key];
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** The fields a user document decides. */
export interface ScimUserFields {
  /** Lower-cased. */
  userName: string;
  externalId: string | null;
  active: boolean;
  /** Lower-cased: the primary email, else the work one, else the first, else a userName that is an address. */
  email: string;
  displayName: string;
  /** What to keep of the document: everything but the server's attributes and any password. */
  raw: Doc;
}

/** Past this the client's extra attributes are dropped and only the core ones kept. */
const MAX_RAW_BYTES = 16_384;
const SERVER_OWNED = new Set(['id', 'meta', 'groups', 'password']);

export function readUserDoc(doc: unknown): ScimUserFields {
  if (!isObject(doc)) throw new ScimError(HttpStatus.BAD_REQUEST, t('error.scim.bodyObject'), 'invalidSyntax');
  const userNameRaw = get(doc, 'userName');
  if (typeof userNameRaw !== 'string' || !userNameRaw.trim()) throw invalidValue(t('error.scim.userNameRequired'));
  const userName = userNameRaw.trim().toLowerCase();
  if (userName.length > 320) throw invalidValue(t('error.scim.userNameRequired'));

  const externalIdRaw = get(doc, 'externalId');
  const externalId = typeof externalIdRaw === 'string' && externalIdRaw.trim() ? externalIdRaw.trim() : null;

  const activeRaw = get(doc, 'active');
  const active = activeRaw === undefined || activeRaw === null ? true : scimBoolean(activeRaw);
  if (active === undefined) throw invalidValue(t('error.scim.activeBoolean'));

  const emails = (Array.isArray(get(doc, 'emails')) ? (get(doc, 'emails') as unknown[]) : []).filter(isObject);
  const pick =
    emails.find((e) => scimBoolean(get(e, 'primary')) === true) ??
    emails.find((e) => String(get(e, 'type') ?? '').toLowerCase() === 'work') ??
    emails[0];
  const picked = pick ? get(pick, 'value') : undefined;
  const email = (typeof picked === 'string' ? picked : EMAIL.test(userName) ? userName : '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 320) throw invalidValue(t('error.scim.emailRequired'));

  const name = isObject(get(doc, 'name')) ? (get(doc, 'name') as Doc) : {};
  const formatted = get(name, 'formatted');
  const given = get(name, 'givenName');
  const family = get(name, 'familyName');
  const display = get(doc, 'displayName');
  const joined = [given, family].filter((p): p is string => typeof p === 'string' && !!p.trim()).join(' ');
  const displayName = (
    (typeof display === 'string' && display.trim()) ||
    (typeof formatted === 'string' && formatted.trim()) ||
    joined ||
    email.slice(0, email.indexOf('@'))
  ).slice(0, 120);

  let raw: Doc = Object.fromEntries(Object.entries(doc).filter(([k]) => !SERVER_OWNED.has(k.toLowerCase())));
  if (JSON.stringify(raw).length > MAX_RAW_BYTES) {
    raw = Object.fromEntries(
      Object.entries(raw).filter(([k]) => ['schemas', 'username', 'name', 'displayname', 'emails', 'active', 'externalid'].includes(k.toLowerCase())),
    );
  }
  return { userName, externalId, active, email, displayName, raw };
}

export interface ScimUserRecord {
  userId: string;
  userName: string | null;
  externalId: string | null;
  active: boolean;
  raw: unknown;
  updatedAt: Date;
  user: { email: string; displayName: string; createdAt: Date };
}

export function renderUser(base: string, rec: ScimUserRecord, groups: { id: string; displayName: string }[]): Doc {
  const raw = isObject(rec.raw) ? rec.raw : {};
  const client = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !['schemas', 'username', 'externalid', 'active'].includes(k.toLowerCase())),
  );
  const schemas = [USER_SCHEMA, ...(Object.keys(raw).some((k) => k === ENTERPRISE_SCHEMA) ? [ENTERPRISE_SCHEMA] : [])];
  return {
    ...client,
    schemas,
    id: rec.userId,
    ...(rec.externalId ? { externalId: rec.externalId } : {}),
    userName: rec.userName ?? rec.user.email,
    displayName: typeof get(raw, 'displayName') === 'string' ? get(raw, 'displayName') : rec.user.displayName,
    emails: Array.isArray(get(raw, 'emails')) ? get(raw, 'emails') : [{ value: rec.user.email, type: 'work', primary: true }],
    active: rec.active,
    groups: groups.map((g) => ({ value: g.id, display: g.displayName, $ref: `${base}/Groups/${g.id}` })),
    meta: {
      resourceType: 'User',
      created: rec.user.createdAt.toISOString(),
      lastModified: rec.updatedAt.toISOString(),
      location: `${base}/Users/${rec.userId}`,
    },
  };
}

/** A user as a PATCH starts from: what a GET shows, minus what the server owns. */
export function patchableUser(rendered: Doc): Doc {
  const { id: _id, meta: _meta, groups: _groups, ...rest } = rendered;
  return rest;
}

export interface ScimGroupRecord {
  id: string;
  displayName: string;
  externalId: string | null;
  updatedAt: Date;
  members: { userId: string; user: { displayName: string } }[];
}

export function renderGroup(base: string, g: ScimGroupRecord, withMembers = true): Doc {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    displayName: g.displayName,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    ...(withMembers
      ? { members: g.members.map((m) => ({ value: m.userId, display: m.user.displayName, $ref: `${base}/Users/${m.userId}` })) }
      : {}),
    meta: { resourceType: 'Group', lastModified: g.updatedAt.toISOString(), location: `${base}/Groups/${g.id}` },
  };
}

export function listResponse(resources: Doc[], total: number, startIndex: number): Doc {
  return { schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources };
}

// --------------------------------------------------------------- discovery

export function serviceProviderConfig(base: string, maxResults: number): Doc {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'A kscim_ token from Settings → Security → Provisioning, sent as Authorization: Bearer.',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}

export function resourceTypes(base: string): Doc[] {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      schema: USER_SCHEMA,
      schemaExtensions: [{ schema: ENTERPRISE_SCHEMA, required: false }],
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      schema: GROUP_SCHEMA,
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` },
    },
  ];
}

const attr = (name: string, extra: Doc = {}): Doc => ({
  name,
  type: 'string',
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

/** The attributes this server reads; any other attribute a client sends is kept and echoed back, not acted on. */
export function schemas(base: string): Doc[] {
  const sub = (names: string[]) => names.map((n) => attr(n));
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: USER_SCHEMA,
      name: 'User',
      attributes: [
        attr('userName', { required: true, uniqueness: 'server' }),
        attr('externalId', { caseExact: true }),
        attr('displayName'),
        attr('name', { type: 'complex', subAttributes: sub(['formatted', 'givenName', 'familyName']) }),
        attr('emails', { type: 'complex', multiValued: true, subAttributes: [...sub(['value', 'type']), attr('primary', { type: 'boolean' })] }),
        attr('active', { type: 'boolean' }),
        attr('groups', { type: 'complex', multiValued: true, mutability: 'readOnly', subAttributes: sub(['value', 'display']) }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${USER_SCHEMA}` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: GROUP_SCHEMA,
      name: 'Group',
      attributes: [
        attr('displayName', { required: true, uniqueness: 'server' }),
        attr('externalId', { caseExact: true }),
        attr('members', { type: 'complex', multiValued: true, subAttributes: sub(['value', 'display']) }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${GROUP_SCHEMA}` },
    },
  ];
}
