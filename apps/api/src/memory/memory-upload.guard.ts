import { Injectable, PayloadTooLargeException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { MemoryAccessService } from './memory-access.service.js';

/** A whole multipart upload to a memory route, every part together: one transfer archive (at most 64 MiB) or a batch of files, plus framing. */
export const MAX_UPLOAD_REQUEST_BYTES = 65 * 1024 * 1024;

/**
 * Runs before the multer interceptor, which buffers every part in memory: the
 * caller must be an editor of the workspace with memory on, and the request
 * must declare a length within the ceiling, before a byte is read. The handler
 * asks `access.caller` again: permission is checked on execution.
 */
@Injectable()
export class MemoryUploadGuard implements CanActivate {
  constructor(private readonly access: MemoryAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { principal: Principal }>();
    await this.access.caller(request.principal, request.header('x-workspace-id'), 'editor');
    // A chunked body declares no length, and multer counts only per file: it is refused, not buffered.
    const length = Number(request.header('content-length'));
    if (!Number.isFinite(length) || length > MAX_UPLOAD_REQUEST_BYTES) throw new PayloadTooLargeException(t('error.memory.uploadTooLarge', { maxBytes: MAX_UPLOAD_REQUEST_BYTES }));
    return true;
  }
}
