import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EXPORT_PRINT_READY_FLAG } from '@knowledge/contracts';
import type { Env } from '../config/env.js';

export class GotenbergError extends Error {}

export interface GotenbergFile {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

/** A4, in the inches Gotenberg's Chromium route takes. */
const A4 = { paperWidth: '8.27', paperHeight: '11.7' };

/**
 * A Gotenberg sidecar's Chromium, used for one thing: printing an export's
 * HTML to PDF (docs/features/45). Optional — GOTENBERG_URL empty means PDF is
 * not offered at all (`ExportService.capabilities`).
 *
 * The HTML goes up as files, not as a URL to fetch: everything the page needs
 * (images, the mermaid bundle) is beside index.html in one flat folder, so
 * Chromium makes no request at all and Gotenberg needs no route back to us.
 * Mermaid draws in that Chromium; the print script raises
 * EXPORT_PRINT_READY_FLAG when it is done and Gotenberg waits for it.
 */
@Injectable()
export class GotenbergClient {
  private readonly base: string;

  constructor(config: ConfigService<Env, true>) {
    this.base = config.get('GOTENBERG_URL', { infer: true }).trim().replace(/\/+$/, '');
  }

  get configured(): boolean {
    return this.base !== '';
  }

  async htmlToPdf(files: GotenbergFile[], signal: AbortSignal): Promise<Uint8Array> {
    if (!this.configured) throw new GotenbergError('GOTENBERG_URL is not set');
    const form = new FormData();
    for (const file of files) {
      form.append('files', new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.contentType }), file.name);
    }
    const fields: Record<string, string> = {
      ...A4,
      marginTop: '0.7',
      marginBottom: '0.7',
      marginLeft: '0.7',
      marginRight: '0.7',
      printBackground: 'true',
      waitForExpression: `window.${EXPORT_PRINT_READY_FLAG} === true`,
    };
    for (const [key, value] of Object.entries(fields)) form.append(key, value);

    let res: Response;
    try {
      res = await fetch(`${this.base}/forms/chromium/convert/html`, { method: 'POST', body: form, signal });
    } catch (e) {
      throw new GotenbergError(`Gotenberg unreachable at ${this.base}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new GotenbergError(`Gotenberg answered ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
