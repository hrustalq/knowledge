import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExportRenderRequest, ExportRenderResponse } from '@knowledge/contracts';
import type { Env } from '../config/env.js';

/** Thrown with what the renderer said, so the row can carry it. */
export class ExportRenderError extends Error {}

/**
 * The worker's call to the web renderer (docs/features/45). The web owns how a
 * page looks — `render.ts` is the one markdown parser, and the reader's server
 * render (`renderPublicMarkdown`) is the one sanitised HTML of it — so an
 * export asks the web for its HTML rather than keeping a second renderer here.
 *
 * WEB_INTERNAL_URL, not WEB_BASE_URL: the route answers only callers on the
 * internal network that came through no proxy, and the public address would
 * reach it through one.
 */
@Injectable()
export class ExportRenderClient {
  private readonly base: string;

  constructor(config: ConfigService<Env, true>) {
    this.base = config.get('WEB_INTERNAL_URL', { infer: true }).replace(/\/+$/, '');
  }

  async render(request: ExportRenderRequest, signal: AbortSignal): Promise<ExportRenderResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/_internal/export/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
    } catch (e) {
      throw new ExportRenderError(`web renderer unreachable at ${this.base}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ExportRenderError(`web renderer answered ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()) as ExportRenderResponse;
  }
}
