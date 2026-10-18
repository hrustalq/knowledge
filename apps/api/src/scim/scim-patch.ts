import { HttpStatus } from '@nestjs/common';
import { t } from '../i18n/t.js';
import { ScimError } from './scim-errors.js';

/**
 * SCIM PATCH (RFC 7644 §3.5.2), as the clients that matter send it.
 *
 * A user PATCH is applied to the user's SCIM document and the result goes
 * through the same path as a PUT, so there is one place that decides what a
 * user document means. A group PATCH is applied to the group's state directly,
 * because member lists are what a group PATCH is about and can be long.
 *
 * Tolerated on purpose, because real clients send them:
 * - Entra ID capitalises the op (`"Replace"`) and sends booleans as strings
 *   (`"active": "False"`) — booleans are coerced where they are read;
 * - Okta replaces with no path and the whole object as the value, `id` included;
 * - Entra removes members with `path: "members"` and a value list, Okta with
 *   `path: 'members[value eq "…"]'`.
 */

export type PatchOpKind = 'add' | 'replace' | 'remove';

export interface PatchOp {
  op: PatchOpKind;
  path?: string;
  value?: unknown;
}

export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (detail: string, scimType: 'invalidSyntax' | 'invalidPath' | 'invalidValue' | 'noTarget' = 'invalidSyntax') =>
  new ScimError(HttpStatus.BAD_REQUEST, detail, scimType);

/** The `Operations` of a PATCH body, with the op lower-cased. */
export function readPatch(body: unknown): PatchOp[] {
  const ops = isObject(body) ? (body.Operations ?? body.operations) : undefined;
  if (!Array.isArray(ops) || !ops.length) throw invalid(t('error.scim.patchOperations'));
  return ops.map((raw) => {
    if (!isObject(raw) || typeof raw.op !== 'string') throw invalid(t('error.scim.patchOperations'));
    const op = raw.op.toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw invalid(t('error.scim.patchOp', { op: raw.op }));
    const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : undefined;
    if (op === 'remove' && !path) throw invalid(t('error.scim.patchRemoveNeedsPath'), 'noTarget');
    return { op, path, value: raw.value } as PatchOp;
  });
}

/** `"True"` / `"False"` (Entra) and real booleans; anything else is not a boolean. */
export function scimBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

// ------------------------------------------------------------------- users

const CORE_URN = /^urn:ietf:params:scim:schemas:core:2\.0:user:/i;
const PATH = /^([A-Za-z][\w$-]*)(?:\[\s*([A-Za-z][\w$-]*)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false)\s*\])?(?:\.([A-Za-z][\w$-]*))?$/i;

interface UserPath {
  attr: string;
  filter?: { attr: string; value: string | boolean };
  sub?: string;
}

/** Where a path points. An extension attribute (`urn:…:enterprise:2.0:User:manager`) lands in that schema's object. */
function parseUserPath(raw: string): { container: string | null; path: UserPath } {
  const stripped = raw.replace(CORE_URN, '');
  if (/^urn:/i.test(stripped)) {
    const at = stripped.lastIndexOf(':');
    const inner = PATH.exec(stripped.slice(at + 1));
    if (!inner) throw invalid(t('error.scim.patchPath', { path: raw }), 'invalidPath');
    return { container: stripped.slice(0, at), path: toPath(inner) };
  }
  const m = PATH.exec(stripped);
  if (!m) throw invalid(t('error.scim.patchPath', { path: raw }), 'invalidPath');
  return { container: null, path: toPath(m) };
}

function toPath(m: RegExpExecArray): UserPath {
  const [, attr, fAttr, fValue, sub] = m;
  if (!fAttr) return { attr, sub };
  const value = fValue === 'true' ? true : fValue === 'false' ? false : (JSON.parse(fValue) as string);
  return { attr, filter: { attr: fAttr, value }, sub };
}

/** The key already holding this attribute, matched case-insensitively (RFC 7643 §2.1), or the given spelling. */
function keyOf(doc: Doc, attr: string): string {
  return Object.keys(doc).find((k) => k.toLowerCase() === attr.toLowerCase()) ?? attr;
}

function matches(item: unknown, filter: NonNullable<UserPath['filter']>): boolean {
  if (!isObject(item)) return false;
  const v = item[keyOf(item, filter.attr)];
  if (typeof filter.value === 'boolean') return scimBoolean(v) === filter.value;
  return typeof v === 'string' && v.toLowerCase() === filter.value.toLowerCase();
}

function applyAt(doc: Doc, op: PatchOpKind, path: UserPath, value: unknown): void {
  const key = keyOf(doc, path.attr);
  if (!path.filter) {
    if (!path.sub) {
      if (op === 'remove') delete doc[key];
      else if (op === 'add' && Array.isArray(doc[key]) && Array.isArray(value)) doc[key] = [...(doc[key] as unknown[]), ...value];
      else if (op === 'add' && isObject(doc[key]) && isObject(value)) doc[key] = { ...(doc[key] as Doc), ...value };
      else doc[key] = value;
      return;
    }
    const inner: Doc = isObject(doc[key]) ? { ...(doc[key] as Doc) } : {};
    const subKey = keyOf(inner, path.sub);
    if (op === 'remove') delete inner[subKey];
    else inner[subKey] = value;
    doc[key] = inner;
    return;
  }

  // A value filter selects elements of a multi-valued attribute: emails[type eq "work"].value.
  const list = Array.isArray(doc[key]) ? [...(doc[key] as unknown[])] : [];
  const filter = path.filter;
  if (op === 'remove') {
    doc[key] = path.sub
      ? list.map((item) => {
          if (!matches(item, filter)) return item;
          const copy = { ...(item as Doc) };
          delete copy[keyOf(copy, path.sub!)];
          return copy;
        })
      : list.filter((item) => !matches(item, filter));
    return;
  }
  const hit = list.findIndex((item) => matches(item, filter));
  const base: Doc = hit >= 0 ? { ...(list[hit] as Doc) } : { [filter.attr]: filter.value };
  const next = path.sub ? { ...base, [keyOf(base, path.sub)]: value } : isObject(value) ? { ...base, ...value } : base;
  if (hit >= 0) list[hit] = next;
  else list.push(next);
  doc[key] = list;
}

/** A user document with the operations applied, in order. The input is not modified. */
export function applyUserPatch(current: Doc, ops: PatchOp[]): Doc {
  const doc: Doc = structuredClone(current);
  for (const { op, path, value } of ops) {
    if (!path) {
      // Okta and Entra both send `{"op":"replace","value":{…}}`; a key may itself be a path.
      if (!isObject(value)) throw invalid(t('error.scim.patchValueObject'), 'invalidValue');
      for (const [k, v] of Object.entries(value)) {
        if (['id', 'meta', 'schemas'].includes(k.toLowerCase())) continue;
        if (/^urn:/i.test(k) && isObject(v) && !CORE_URN.test(`${k}:`)) {
          const key = keyOf(doc, k);
          doc[key] = op === 'add' && isObject(doc[key]) ? { ...(doc[key] as Doc), ...v } : v;
          continue;
        }
        target(doc, k, (into, p) => applyAt(into, op, p, v));
      }
      continue;
    }
    target(doc, path, (into, p) => applyAt(into, op, p, value));
  }
  return doc;
}

function target(doc: Doc, raw: string, apply: (into: Doc, path: UserPath) => void): void {
  const { container, path } = parseUserPath(raw);
  if (!container) {
    apply(doc, path);
    return;
  }
  const key = keyOf(doc, container);
  const inner: Doc = isObject(doc[key]) ? { ...(doc[key] as Doc) } : {};
  apply(inner, path);
  doc[key] = inner;
}

// ------------------------------------------------------------------ groups

export interface GroupState {
  displayName: string;
  externalId: string | null;
  members: Set<string>;
}

/** `[{"value":"<id>"}]`, a bare id, or a list of either. */
export function memberIds(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return items.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (isObject(item) && typeof item.value === 'string') return [item.value];
    throw invalid(t('error.scim.memberValue'), 'invalidValue');
  });
}

const MEMBER_FILTER = /^members\s*\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i;

/** A group's state with the operations applied, in order. The input is not modified. */
export function applyGroupPatch(current: GroupState, ops: PatchOp[]): GroupState {
  const next: GroupState = { ...current, members: new Set(current.members) };
  const setField = (field: string, value: unknown, op: PatchOpKind) => {
    const f = field.toLowerCase();
    if (f === 'displayname') {
      if (op === 'remove' || typeof value !== 'string' || !value.trim()) throw invalid(t('error.scim.displayNameRequired'), 'invalidValue');
      next.displayName = value.trim();
    } else if (f === 'externalid') {
      next.externalId = op === 'remove' || value === null ? null : typeof value === 'string' ? value : next.externalId;
    } else if (f === 'members') {
      const ids = op === 'remove' && value === undefined ? [...next.members] : memberIds(value);
      if (op === 'replace') next.members = new Set(ids);
      else if (op === 'add') ids.forEach((id) => next.members.add(id));
      else ids.forEach((id) => next.members.delete(id));
    }
    // Anything else (`id`, `meta`, `schemas`) is the server's, and ignored.
  };

  for (const { op, path, value } of ops) {
    if (!path) {
      if (!isObject(value)) throw invalid(t('error.scim.patchValueObject'), 'invalidValue');
      for (const [k, v] of Object.entries(value)) setField(k, v, op);
      continue;
    }
    const filtered = MEMBER_FILTER.exec(path);
    if (filtered) {
      const id = JSON.parse(`"${filtered[1]}"`) as string;
      if (op === 'remove') next.members.delete(id);
      else next.members.add(id);
      continue;
    }
    const field = path.replace(/^urn:ietf:params:scim:schemas:core:2\.0:group:/i, '');
    if (!['displayname', 'externalid', 'members'].includes(field.toLowerCase())) {
      throw invalid(t('error.scim.patchPath', { path }), 'invalidPath');
    }
    setField(field, value, op);
  }
  return next;
}
