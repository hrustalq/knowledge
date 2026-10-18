import { HttpException, HttpStatus } from '@nestjs/common';
import type { ScimType } from '../common/scim-error-body.js';

export { SCIM_CONTENT_TYPE, type ScimType } from '../common/scim-error-body.js';

/**
 * A refusal a SCIM client can act on. The body is the house shape with
 * `scimType` as a flat extra; `ApiExceptionFilter` turns it into RFC 7644's
 * error for anything under /v1/scim.
 */
export class ScimError extends HttpException {
  constructor(status: HttpStatus, detail: string, readonly scimType?: ScimType) {
    super({ statusCode: status, message: detail, ...(scimType ? { scimType } : {}) }, status);
  }
}
