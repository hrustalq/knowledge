import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { ExternalDocument } from './adapters/connector.types.js';

/**
 * A leaf module on purpose: the sync engine, the staging engine and the API-side
 * item service all need these two functions, and the first two import each
 * other's neighbours. Keeping them here means nothing has to import a service to
 * hash a string — the `activity/actor.ts` split, for the same reason.
 */

/** Frontmatter is re-attached so the deterministic relation extractor sees it. */
export function composeMarkdown(doc: ExternalDocument): string {
  const data = doc.frontmatter ?? {};
  const body = doc.markdown.trim();
  return Object.keys(data).length > 0 ? matter.stringify(body, data) : body;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
