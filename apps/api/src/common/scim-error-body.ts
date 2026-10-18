/**
 * RFC 7644 §3.12 error shape (#75). Here rather than in scim/ because
 * `ApiExceptionFilter` renders it for every failure under /v1/scim — an
 * unmatched route or a body-parser error never reaches a SCIM class — and
 * common/ is the base layer every feature imports, never the reverse.
 */

export const SCIM_CONTENT_TYPE = 'application/scim+json';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
/** Every SCIM route lives under this prefix. */
export const SCIM_PATH_PREFIX = '/v1/scim/';

/** The `scimType` values this server emits. */
export type ScimType = 'invalidFilter' | 'invalidSyntax' | 'invalidPath' | 'invalidValue' | 'uniqueness' | 'mutability' | 'noTarget';

/** `status` is a string, `scimType` only for the 400/409 cases that have one. */
export interface ScimErrorBody {
  schemas: [typeof SCIM_ERROR_SCHEMA];
  status: string;
  scimType?: ScimType;
  detail: string;
}

export function scimErrorBody(status: number, detail: string, scimType?: ScimType): ScimErrorBody {
  return { schemas: [SCIM_ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail };
}
