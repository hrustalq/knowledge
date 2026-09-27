import type { Response } from 'express';
import type { PageMarkdownResult } from './ai-readable.service.js';

/**
 * Write a page-markdown result onto the response. Shared by `/markdown` and by
 * the negotiated `/content`, so the two cannot answer with different headers.
 *
 * `private, no-cache`: this is authenticated content and must never land in a
 * shared cache — Publishing will switch it. `nosniff` stops a browser from
 * rendering the markdown as HTML.
 */
export function sendPageMarkdown(res: Response, result: PageMarkdownResult): string | undefined {
  res.setHeader('ETag', result.etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('Vary', 'Accept, Authorization, Cookie');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (result.status === 304) {
    res.status(304);
    return undefined;
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Link', `<${result.llmsIndexUrl}>; rel="alternate"; type="text/plain"`);
  return result.body;
}
