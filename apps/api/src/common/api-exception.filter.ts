import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { type ApiErrorCode, type ApiErrorPayload, API_ERROR_CODES, errorCodeForStatus } from '@knowledge/contracts';
import { t } from '../i18n/t.js';

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
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const headerId = req.headers['x-request-id'];
    const requestId = (Array.isArray(headerId) ? headerId[0] : headerId) ?? randomUUID();

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
    } else {
      // Unexpected throw: never leak internals to the client, always log them.
      this.logger.error(
        `Unhandled exception on ${req.method} ${req.originalUrl ?? req.url} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (status >= 500 && exception instanceof HttpException) {
      this.logger.error(`HTTP ${status} on ${req.method} ${req.originalUrl ?? req.url} [${requestId}]: ${message}`);
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
