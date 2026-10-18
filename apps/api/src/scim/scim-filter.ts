/**
 * The SCIM filter subset this server answers (RFC 7644 §3.4.2.2): one `eq`
 * comparison on an attribute a provisioning client actually matches on.
 * Entra ID, Okta and the Keycloak SCIM plugin look a person up by `userName`
 * (sometimes `externalId` or the work email) before creating them, and a group
 * by `displayName`; that is all a filter is for here. Anything wider — `and`,
 * `co`, `sw`, presence — is a 400 `invalidFilter` rather than a silently
 * wrong answer.
 */

export type ScimUserFilterAttribute = 'id' | 'userName' | 'externalId' | 'email';
export type ScimGroupFilterAttribute = 'id' | 'displayName' | 'externalId';

export interface ScimFilter<A extends string> {
  attribute: A;
  value: string;
}

/** Attribute paths are case-insensitive (RFC 7643 §2.1), and so is the spacing inside a value filter. */
const USER_ATTRIBUTES: Record<string, ScimUserFilterAttribute> = {
  id: 'id',
  username: 'userName',
  externalid: 'externalId',
  'emails.value': 'email',
  'emails[type eq "work"].value': 'email',
  'emails[primary eq true].value': 'email',
};
const GROUP_ATTRIBUTES: Record<string, ScimGroupFilterAttribute> = {
  id: 'id',
  displayname: 'displayName',
  externalid: 'externalId',
};

const COMPARISON = /^\s*(\S(?:.*?\S)?)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;
const CORE_URN = /^urn:ietf:params:scim:schemas:core:2\.0:(?:user|group):/i;

function normalizePath(raw: string): string {
  return raw
    .replace(CORE_URN, '')
    .toLowerCase()
    .replace(/\s*\[\s*/g, '[')
    .replace(/\s*\]\s*/g, ']')
    .replace(/\[(\w+)\s+eq\s+/g, '[$1 eq ');
}

function parse<A extends string>(raw: string, attributes: Record<string, A>): ScimFilter<A> | null {
  const m = COMPARISON.exec(raw);
  if (!m) return null;
  const attribute = attributes[normalizePath(m[1])];
  if (!attribute) return null;
  let value: string;
  try {
    value = JSON.parse(`"${m[2]}"`) as string;
  } catch {
    return null;
  }
  return { attribute, value };
}

/** Null when the filter is outside the supported subset: the caller answers 400 `invalidFilter`. */
export function parseUserFilter(raw: string): ScimFilter<ScimUserFilterAttribute> | null {
  return parse(raw, USER_ATTRIBUTES);
}

export function parseGroupFilter(raw: string): ScimFilter<ScimGroupFilterAttribute> | null {
  return parse(raw, GROUP_ATTRIBUTES);
}
