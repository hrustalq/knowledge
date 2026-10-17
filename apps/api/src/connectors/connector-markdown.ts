import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { apiSpecContentType } from '@knowledge/contracts';
import type { ExternalDocument } from './adapters/connector.types.js';

/**
 * A leaf module on purpose: the sync engine, the staging engine and the API-side
 * item service all need these two functions, and the first two import each
 * other's neighbours. Keeping them here means nothing has to import a service to
 * hash a string — the `activity/actor.ts` split, for the same reason.
 */

/**
 * Frontmatter is re-attached so the deterministic relation extractor sees it.
 * A spec (#78) is stored as written: YAML or JSON has no frontmatter to carry.
 */
export function composeMarkdown(doc: ExternalDocument): string {
  if (doc.spec) return doc.markdown;
  const data = doc.frontmatter ?? {};
  const body = doc.markdown.trim();
  return Object.keys(data).length > 0 ? matter.stringify(body, data) : body;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A staged item's object name and content type: `staged.md`, or
 * `staged.yaml` / `staged.json` for a spec (#78). Here for the reason the rest
 * of this file is: staging writes it and the API-side item service rewrites it.
 */
export function stagedObject(
  spec: ExternalDocument['spec'],
  which: 'staged' | 'incoming',
): { name: string; contentType: string } {
  if (!spec) return { name: `${which}.md`, contentType: 'text/markdown' };
  return { name: `${which}.${spec.syntax}`, contentType: apiSpecContentType(spec.kind, spec.syntax) };
}
