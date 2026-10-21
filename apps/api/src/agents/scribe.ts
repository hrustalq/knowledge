import type { AgentFinding, AssistantWebSource } from '@knowledge/contracts';
import { wrapUntrusted } from '../common/untrusted.js';
import { MIN_DRAFT_CHARS } from './coverage.js';

/**
 * The scribe (#433): a tracker ticket asks for documentation, and the run
 * proposes it — pages to create, or pages to rewrite — as findings that
 * `ScribePublishSweeper` opens as merge requests. Pure helpers, like
 * `coverage.ts`: the prompt, and the validation of what the model answered.
 */

/** Proposals kept from one ticket. Each becomes a merge request, so this is the reviewer's load. */
export const MAX_SCRIBE_PAGES = 3;
/** How much of the ticket body the model is shown. */
const MAX_TICKET_CHARS = 12_000;

export const SCRIBE_OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape {"summary": string, "pages": [{"action": "create"|"update", ' +
  '"documentId"?: string, "title": string, "detail": string, "markdown": string}]}. "summary" says in one or ' +
  'two sentences what the ticket asks for and what you propose. Search the knowledge base first. Use ' +
  '"update" when an existing page is the right home — "documentId" copied exactly from a tool result, and ' +
  '"markdown" the complete new body of that page, keeping everything it says that the ticket does not ' +
  'change. Use "create" when no page covers it — "markdown" is the complete page. "detail" says in one ' +
  `sentence what changed and why. At most ${MAX_SCRIBE_PAGES} pages; an empty list when the ticket asks for ` +
  'nothing the knowledge base should hold. Write only what the ticket and the pages you read state, with a ' +
  'plain "What is not yet known" section for anything they leave open. Never invent behaviour.';

export interface ScribeTicket {
  /** `BILL-123` or `#45`. */
  key: string;
  title: string;
  url: string;
  labels: string[];
  body: string | null;
}

/**
 * The user turn. The whole ticket is wrapped untrusted: anyone who can file a
 * ticket in the tracker wrote it, and "ignore your instructions" is a ticket
 * somebody will file.
 */
export function scribePrompt(ticket: ScribeTicket): string {
  const text =
    `${ticket.key}: ${ticket.title}\n` +
    (ticket.labels.length ? `Labels: ${ticket.labels.join(', ')}\n` : '') +
    `\n${(ticket.body ?? '').slice(0, MAX_TICKET_CHARS)}`;
  return 'A ticket in the team tracker asks the knowledge base for documentation.\n\n' + wrapUntrusted(text, 'ticket', 'task');
}

/** The ticket as a cited source, so every merge request links back to it. */
function ticketSource(ticket: ScribeTicket): AssistantWebSource {
  let site = '';
  try {
    site = new URL(ticket.url).host;
  } catch {
    // A tracker URL that does not parse still names the ticket.
  }
  return { kind: 'web', url: ticket.url, site, title: `${ticket.key} ${ticket.title}`.slice(0, 300) };
}

/** The ids the answer names, before any is checked — one query validates them all. */
export function scribeCitedIds(value: unknown): string[] {
  const pages = (value as { pages?: unknown } | null)?.pages;
  return Array.isArray(pages)
    ? pages.flatMap((p) => (p && typeof p === 'object' && typeof (p as { documentId?: unknown }).documentId === 'string' ? [(p as { documentId: string }).documentId] : []))
    : [];
}

/**
 * The proposals, validated rather than trusted: an update needs a page the run
 * may read (`known`, id → title) and is dropped otherwise rather than turned
 * into a new page that would duplicate it; a body shorter than a page is a
 * sentence and is dropped; one page is updated at most once. A create cites
 * no page — the shape `proposePage` publishes — and an update cites exactly
 * the page it rewrites, the one `propose` changes.
 */
export function readScribeDrafts(
  value: unknown,
  known: ReadonlyMap<string, string>,
  ticket: ScribeTicket,
): { summary: string | null; findings: AgentFinding[] } {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 2_000) : null;
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  const source = ticketSource(ticket);
  const updated = new Set<string>();
  const findings: AgentFinding[] = [];
  for (const entry of pages) {
    if (findings.length >= MAX_SCRIBE_PAGES) break;
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, 300) : '';
    const markdown = typeof p.markdown === 'string' ? p.markdown.trim().slice(0, 40_000) : '';
    if (!title || markdown.length < MIN_DRAFT_CHARS) continue;
    const detail =
      typeof p.detail === 'string' && p.detail.trim() ? p.detail.trim().slice(0, 2_000) : `${ticket.key}: ${ticket.title}`;
    const id = typeof p.documentId === 'string' ? p.documentId : '';
    const update = p.action === 'update';
    if (update) {
      if (!known.has(id) || updated.has(id)) continue;
      updated.add(id);
    }
    findings.push({
      kind: 'gap',
      severity: 'info',
      title,
      detail,
      documentIds: update ? [id] : [],
      documentTitles: update ? [known.get(id) as string] : [],
      draft: { title, markdown },
      sources: [source],
    });
  }
  return { summary, findings };
}
