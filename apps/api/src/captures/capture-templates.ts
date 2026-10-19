import { CHAT_PLATFORM_NAMES } from '@knowledge/contracts';
import type {
  AnswerCapturePayload,
  CaptureKind,
  CaptureOrigin,
  CaptureSession,
  DecisionCapturePayload,
  NoteCapturePayload,
} from '@knowledge/contracts';

/**
 * Page text from a capture (issue #73): a fixed template per kind, so a
 * reviewer always finds the same sections in the same order, and so nothing
 * here calls a model. Pure — the headings arrive already translated, which is
 * what lets a spec render both catalogues without booting i18n.
 *
 * The agent's own text goes in as written. It is markdown a person reviews in
 * a merge request and the page renderer sanitizes; it is never handed to a
 * model from here (anything that later does wraps it untrusted).
 */

/** `capture.heading.*`, resolved by the caller in the writer's language. */
export interface CaptureHeadings {
  context: string;
  decision: string;
  consequences: string;
  alternatives: string;
  related: string;
  appliesTo: string;
  question: string;
  answer: string;
  sources: string;
  /** With `{title}` already filled in. */
  captured: string;
}

export const CAPTURE_HEADING_KEYS = [
  'context',
  'decision',
  'consequences',
  'alternatives',
  'related',
  'appliesTo',
  'question',
  'answer',
  'sources',
] as const;

/** A page a capture links to, by id and title. */
export interface LinkedPage {
  documentId: string;
  title: string;
}

export type CaptureBodyInput =
  | { kind: 'decision'; payload: DecisionCapturePayload; related: LinkedPage[] }
  | { kind: 'gotcha' | 'convention' | 'howto'; payload: NoteCapturePayload }
  | { kind: 'answer'; payload: AnswerCapturePayload; cited: LinkedPage[] };

/**
 * The body of a page-kind capture, its sections at `level` (2 for a page of
 * its own, 3 under the `## Captured: …` heading an amended page gets).
 */
export function renderCaptureBody(input: CaptureBodyInput, h: CaptureHeadings, level: 2 | 3 = 2): string {
  const hashes = '#'.repeat(level);
  const sections: string[] = [];
  const section = (heading: string, text: string | undefined) => {
    if (text?.trim()) sections.push(`${hashes} ${heading}\n\n${text.trim()}`);
  };
  const list = (items: readonly string[] | undefined) => (items ?? []).map((i) => `- ${i.trim()}`).join('\n');
  const links = (pages: readonly LinkedPage[]) => list(pages.map((p) => `[${escapeLinkText(p.title)}](/documents/${p.documentId})`));

  switch (input.kind) {
    case 'decision':
      section(h.context, input.payload.context);
      section(h.decision, input.payload.decision);
      section(h.consequences, input.payload.consequences);
      section(h.alternatives, list(input.payload.alternatives));
      section(h.related, links(input.related));
      break;
    case 'answer':
      section(h.question, input.payload.question);
      section(h.answer, input.payload.answer);
      section(h.sources, links(input.cited));
      break;
    default:
      if (input.payload.body.trim()) sections.push(input.payload.body.trim());
      section(h.appliesTo, list(input.payload.appliesTo?.map((p) => `\`${p.replace(/`/g, '')}\``)));
  }
  return sections.join('\n\n');
}

/** An existing page's body with a capture appended as its own `##` section. */
export function appendCaptureSection(pageBody: string, body: string, h: CaptureHeadings): string {
  const head = pageBody.replace(/\s+$/, '');
  return `${head ? `${head}\n\n` : ''}## ${h.captured}\n\n${body}\n`;
}

/** One `captured:` frontmatter entry: where it came from, never what the session said. */
export interface CapturedEntry {
  id: string;
  kind: CaptureKind;
  client: string;
  sessionId?: string;
  repo?: string;
  commit?: string;
  at: string;
}

export function capturedEntry(id: string, kind: CaptureKind, session: CaptureSession, at: Date): CapturedEntry {
  return {
    id,
    kind,
    client: session.client,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session.repo ? { repo: session.repo } : {}),
    ...(session.commit ? { commit: session.commit } : {}),
    at: at.toISOString(),
  };
}

/**
 * The page's frontmatter with `entry` appended to its `captured:` list. Every
 * other key is carried over untouched; a `captured` that is not a list (a
 * person typed something there) is kept as the first entry rather than lost.
 */
export function withCapturedEntry(frontmatter: Record<string, unknown>, entry: CapturedEntry): Record<string, unknown> {
  return appendEntry(frontmatter, 'captured', entry);
}

/**
 * The frontmatter with a chat capture's origin appended to its `sources:`
 * list (#82) — the conversation the page text came from. Unchanged when there
 * is no origin; a `sources` that is not a list is kept as the first entry.
 */
export function withOriginSource(frontmatter: Record<string, unknown>, origin: CaptureOrigin | null): Record<string, unknown> {
  return origin ? appendEntry(frontmatter, 'sources', origin) : frontmatter;
}

function appendEntry(frontmatter: Record<string, unknown>, key: string, item: unknown): Record<string, unknown> {
  const existing = frontmatter[key];
  const list = Array.isArray(existing) ? existing : existing === undefined || existing === null ? [] : [existing];
  return { ...frontmatter, [key]: [...list, item] };
}

/** `telegram · Team chat · <link>` — where in a chat a capture came from; `dm` names a chat with no title. */
export function describeOrigin(origin: CaptureOrigin, dm: string): string {
  const platform = CHAT_PLATFORM_NAMES[origin.platform as keyof typeof CHAT_PLATFORM_NAMES] ?? origin.platform;
  return [platform, origin.chatTitle ?? dm, origin.threadUrl].filter(Boolean).join(' · ');
}

/** `client · repo@commit` — the one-line source a reviewer reads in the merge request. */
export function describeSession(session: CaptureSession): string {
  const where = session.repo ? `${session.repo}${session.commit ? `@${session.commit.slice(0, 12)}` : ''}` : null;
  return [session.client, where, session.branch ? `(${session.branch})` : null].filter(Boolean).join(' · ');
}

function escapeLinkText(text: string): string {
  return text.replace(/[[\]]/g, (c) => `\\${c}`);
}
