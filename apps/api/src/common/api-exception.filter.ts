import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { type ApiErrorCode, type ApiErrorPayload, API_ERROR_CODES, errorCodeForStatus } from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { currentTrace } from '@knowledge/observability';

/**
 * Global HTTP exception filter: normalizes EVERY error — HttpException,
 * class-validator 400s, unexpected throws — into the strict ApiErrorPayload
 * envelope from @knowledge/contracts. Registered in main.ts only, so the
 * worker / MCP entrypoints are untouched.
 *
 * Custom exception bodies keep working: extra keys thrown via
 * `new ConflictException({ message, comparisonUrl, … })` are hoisted into
 * `details` (see RevisionConflictResponse in contracts).
 */
/**
 * body-parser's PayloadTooLargeError, which reaches this filter unwrapped.
 *
 * `type` is the stable discriminator across body-parser versions; http-errors
 * sets both `status` and `statusCode`, and which one survives depends on how the
 * error was constructed — so test `type` first and accept either numeric field.
 */
function isPayloadTooLarge(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  return e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // The trace scope opened at request entry owns the id. This filter used to
    // mint one here, which meant a successful request had no id at all and an
    // error's id correlated to nothing that came before it. The header and
    // randomUUID remain as fallbacks for a throw raised outside a scope.
    const headerId = req.headers['x-request-id'];
    const requestId =
      currentTrace()?.traceId ?? (Array.isArray(headerId) ? headerId[0] : headerId) ?? randomUUID();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = t('error.internal');
    let code: ApiErrorCode | undefined;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        // Nest default bodies: { statusCode, message, error }. Custom bodies may
        // carry anything else — keep the strict envelope, move extras to details.
        const { statusCode: _s, error: _e, message: rawMessage, code: rawCode, ...extras } = body as Record<string, unknown>;
        if (Array.isArray(rawMessage)) {
          // class-validator ValidationPipe: message is string[]
          message = 'Validation failed';
          code = 'VALIDATION_FAILED';
          details = { errors: rawMessage };
        } else {
          message = typeof rawMessage === 'string' ? rawMessage : exception.message;
          // Nest's router 404 for an unmatched path ("Cannot GET /v1/nope") is
          // produced by the framework, never by a throw site, so it is the one
          // message that has to be recognised rather than translated at source.
          const unmatched = /^Cannot ([A-Z]+) (.+)$/.exec(message);
          if (status === HttpStatus.NOT_FOUND && unmatched) {
            message = t('error.routeNotFound', { method: unmatched[1], path: unmatched[2] });
          }
        }
        if (typeof rawCode === 'string' && (API_ERROR_CODES as readonly string[]).includes(rawCode)) {
          code = rawCode as ApiErrorCode;
        }
        if (Object.keys(extras).length > 0) details = { ...details, ...extras };
      }
    } else if (isPayloadTooLarge(exception)) {
      // body-parser throws a bare PayloadTooLargeError, not an HttpException, so
      // without this branch it fell through to `else` and surfaced as an
      // untranslated 500 that never mentioned size — the whole reason a large
      // paste "just errored" on every prose surface.
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      code = 'PAYLOAD_TOO_LARGE';
      message = t('error.payloadTooLarge');
      // Worth seeing, but it is a client mistake, not an incident.
      this.logger.warn({
        msg: 'Request body too large',
        code,
        method: req.method,
        route: req.originalUrl ?? req.url,
      });
    } else {
      // Unexpected throw: never leak internals to the client, always log them.
      this.logger.error({
        msg: 'Unhandled exception',
        code: 'UNHANDLED_EXCEPTION',
        method: req.method,
        route: req.originalUrl ?? req.url,
        err: exception instanceof Error ? exception : { message: String(exception) },
      });
    }

    if (status >= 500 && exception instanceof HttpException) {
      // Carries `err` now. This branch logged without a stack while the one
      // above logged with it, which made an InternalServerErrorException thrown
      // from a service the hardest kind of 500 to debug.
      this.logger.error({
        msg: message,
        code: code ?? errorCodeForStatus(status),
        status,
        method: req.method,
        route: req.originalUrl ?? req.url,
        err: exception,
      });
    }

    const payload: ApiErrorPayload = {
      statusCode: status,
      code: code ?? errorCodeForStatus(status),
      message,
      ...(details ? { details } : {}),
      path: req.originalUrl ?? req.url,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.setHeader('x-request-id', requestId);
    res.status(status).json(payload);
  }
}
