import { memoClock as clock, type AgentFinding, type AssistantWebSource, type MemoDropped, type MemoSegment } from '@knowledge/contracts';
import { wrapUntrusted } from '../common/untrusted.js';
import { MIN_DRAFT_CHARS } from './coverage.js';

/**
 * The secretary (#551, docs/features/68): a memo's transcript in, page
 * proposals out as findings `MemoPublishSweeper` opens as merge requests.
 * Pure helpers, like `scribe.ts` — the prompt, and the validation of what the
 * model answered, which is where the rules are enforced rather than asked for.
 */

/**
 * How much transcript the model is shown. Two hours of speech is ≈ 110k
 * characters, so the ceiling only bites past `MEMO_MAX_MINUTES`' default.
 * ponytail: one window, the tail is cut; split into passes if long memos lose their end.
 */
const MAX_TRANSCRIPT_CHARS = 150_000;

export function memoOutputContract(max: number): string {
  return (
    'Respond ONLY with a json object of the shape {"summary": string, "proposals": [{"action": "create"|"update", ' +
    '"documentId"?: string, "title": string, "detail": string, "markdown": string, "segments": number[]}]}. ' +
    '"summary" says in two or three sentences what the recording settled. Search the knowledge base for every ' +
    'subject the recording decides or changes, and read the closest pages. Use "update" when an existing page is ' +
    'the right home — "documentId" copied exactly from a tool result, "markdown" the complete new body of that ' +
    'page, keeping everything it says that the recording does not change. Use "create" when no page covers it — ' +
    '"markdown" is the complete page. "segments" lists the [n] numbers of the transcript lines the change rests ' +
    `on; every proposal cites at least one. "detail" says in one sentence what changed and why. At most ${max} ` +
    'proposals, the most consequential first; an empty list when the recording settles nothing the knowledge ' +
    'base should hold — small talk, status updates and open questions are not decisions. Write only what the ' +
    'recording and the pages you read state, in the language of the page you update (or of the recording, for a ' +
    'new page). Never invent behaviour, never name who said what, and never copy a [EMAIL_1]-style placeholder ' +
    'into a page.'
  );
}

/**
 * The user turn: the transcript as numbered, timed lines, wrapped untrusted —
 * a recording is what people in a room said, and "ignore your instructions"
 * is a thing somebody will say. The memo's title is the uploader's and stays
 * outside the wrapper.
 */
export function memoPrompt(title: string, segments: MemoSegment[]): string {
  let text = '';
  for (const s of segments) {
    const line = `[${s.i}] ${clock(s.start)}–${clock(s.end)} ${s.text}\n`;
    if (text.length + line.length > MAX_TRANSCRIPT_CHARS) {
      text += '[…the rest of the recording is not shown]\n';
      break;
    }
    text += line;
  }
  return (
    `A team member recorded a conversation and asks what it changes in the knowledge base. Their title for it: ` +
    `${JSON.stringify(title)}.\n\n` +
    wrapUntrusted(text, 'memo', 'memo')
  );
}

/** The ids the answer names, before any is checked — one query validates them all. */
export function memoCitedIds(value: unknown): string[] {
  const proposals = (value as { proposals?: unknown } | null)?.proposals;
  return Array.isArray(proposals)
    ? proposals.flatMap((p) => {
        const id = p && typeof p === 'object' ? (p as { documentId?: unknown }).documentId : undefined;
        return typeof id === 'string' ? [id] : [];
      })
    : [];
}

export interface MemoProposalContext {
  /** Every page id this run's own tool calls returned. */
  retrieved: ReadonlySet<string>;
  /** Of the pages the answer names, those the uploader may read, id → title. */
  visible: ReadonlyMap<string, string>;
  /** The transcript the run was shown; a citation outside it is invented. */
  segments: readonly MemoSegment[];
  max: number;
  /** The memo page at a moment — the link every merge request carries back. */
  linkAt: (seconds: number) => string;
  /** `Memo · 12:03` — time only, never the memo's title or words. */
  label: (clockText: string) => string;
}

/**
 * The proposals, validated rather than trusted. A proposal is dropped — and
 * kept with its reason, which the memo page shows — when it cites a segment
 * the transcript does not have (or none), updates a page the run never
 * retrieved or the uploader cannot read, is shorter than a page, repeats an
 * update of the same page, or falls past the limit. A create cites no page
 * (`proposePage`'s shape), an update exactly the page it rewrites (`propose`'s).
 */
export function readMemoProposals(
  value: unknown,
  ctx: MemoProposalContext,
): { summary: string | null; findings: AgentFinding[]; dropped: MemoDropped[] } {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 2_000) : null;
  const proposals = Array.isArray(raw.proposals) ? raw.proposals : [];
  const byIndex = new Map(ctx.segments.map((s) => [s.i, s]));
  const updated = new Set<string>();
  const findings: AgentFinding[] = [];
  const dropped: MemoDropped[] = [];
  for (const entry of proposals) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, 300) : '';
    const markdown = typeof p.markdown === 'string' ? p.markdown.trim().slice(0, 40_000) : '';
    const drop = (reason: MemoDropped['reason']) => dropped.push({ title: title || '—', reason });
    const cited = Array.isArray(p.segments) ? [...new Set(p.segments)] : [];
    const segments = cited.flatMap((n) => (typeof n === 'number' && byIndex.has(n) ? [byIndex.get(n)!] : []));
    if (cited.length === 0 || segments.length !== cited.length) {
      drop('unknown-segment');
      continue;
    }
    const update = p.action === 'update';
    const id = typeof p.documentId === 'string' ? p.documentId : '';
    // Both, or it is a guess: a page the uploader can read but the run never
    // looked at is not one the model knows the content of.
    if (update && !(ctx.retrieved.has(id) && ctx.visible.has(id))) {
      drop('unknown-page');
      continue;
    }
    if (!title || markdown.length < MIN_DRAFT_CHARS) {
      drop('too-short');
      continue;
    }
    if (update && updated.has(id)) {
      drop('duplicate');
      continue;
    }
    if (findings.length >= ctx.max) {
      drop('over-limit');
      continue;
    }
    if (update) updated.add(id);
    segments.sort((a, b) => a.start - b.start);
    const detail = typeof p.detail === 'string' && p.detail.trim() ? p.detail.trim().slice(0, 2_000) : title;
    findings.push({
      kind: 'gap',
      severity: 'info',
      title,
      detail,
      documentIds: update ? [id] : [],
      documentTitles: update ? [ctx.visible.get(id) as string] : [],
      draft: { title, markdown },
      sources: segments.map((s): AssistantWebSource => ({
        kind: 'web',
        url: ctx.linkAt(Math.floor(s.start)),
        site: '',
        title: ctx.label(clock(s.start)),
      })),
      memo: { action: update ? 'update' : 'create', segments: segments.map((s) => s.i) },
    });
  }
  return { summary, findings, dropped };
}
