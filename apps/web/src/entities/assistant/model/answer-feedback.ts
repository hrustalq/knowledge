// The vote logic behind AnswerFeedback.vue (docs/features/38, phase 2), kept
// as plain functions so it can be unit-tested without a DOM: which pane a vote
// is from, what pressing a thumb means given the vote that is already there,
// what the request carries, and when a down-vote is allowed to be sent.
import type {
  AnswerFeedbackReason,
  AnswerRating,
  AnswerSurface,
  AnswerVote,
  AssistantAskSource,
  AssistantSource,
  KnowledgeIssueKind,
  KnowledgeIssueSurface,
} from '@knowledge/contracts'
import { isPageSource } from '@knowledge/contracts'

/** What the component is rating: a persisted reply, or a one-shot `/ask` answer the API never stored. */
export type FeedbackTarget =
  | { kind: 'message'; messageId: string }
  | {
      kind: 'ask'
      workspaceId: string
      query: string
      answer: string
      sources: readonly AssistantAskSource[]
    }

/**
 * The same `ChatPane` is mounted on `/assistant` and beside the editor
 * (docs/features/34). The API cannot tell which from a message row, so the
 * client says — and the only thing that distinguishes the two is whether an
 * editor has registered its draft bridge.
 */
export function voteSurface(hasDraft: boolean): Extract<AnswerSurface, 'assistant' | 'editor-assistant'> {
  return hasDraft ? 'editor-assistant' : 'assistant'
}

/**
 * Pressing a thumb is a toggle against the vote that is already there:
 * pressing the active one takes it back, pressing the other switches. A
 * thumbs-down that is not yet a vote first needs its reason, so it opens the
 * form rather than sending.
 */
export type ThumbAction = 'retract' | 'vote-up' | 'open-down-form'

export function thumbAction(current: AnswerVote | null, pressed: AnswerRating): ThumbAction {
  if (current?.rating === pressed) return 'retract'
  return pressed === 'up' ? 'vote-up' : 'open-down-form'
}

/** A thumbs-down needs a reason; a thumbs-up never does. Mirrors the API's DTO rule. */
export function canSend(rating: AnswerRating, reason: AnswerFeedbackReason | null): boolean {
  return rating === 'up' || reason !== null
}

export interface VoteDraft {
  rating: AnswerRating
  reason: AnswerFeedbackReason | null
  comment: string
}

/** The body of `PUT /messages/:id/feedback` or `POST /ask/feedback`, from the target and the draft. */
export function voteBody(target: FeedbackTarget, draft: VoteDraft, surface: AnswerSurface): Record<string, unknown> {
  const comment = draft.comment.trim()
  const vote = {
    rating: draft.rating,
    ...(draft.reason ? { reason: draft.reason } : {}),
    ...(comment ? { comment } : {}),
  }
  if (target.kind === 'message') return { ...vote, surface }
  return {
    ...vote,
    workspaceId: target.workspaceId,
    query: target.query.slice(0, 4_000),
    answerExcerpt: target.answer.slice(0, 1_000),
    citedDocumentIds: [...new Set(target.sources.map((s) => s.documentId))].slice(0, 20),
  }
}

/** What the thumbs show right after a successful vote, before the server copy is read back. */
export function optimisticVote(draft: VoteDraft): AnswerVote {
  return {
    rating: draft.rating,
    reason: draft.reason,
    comment: draft.comment.trim() || null,
    createdAt: new Date().toISOString(),
  }
}

// ---- a down-vote that names its pages (docs/features/38, phase 3) ---------


/**
 * The two reasons that name a page: the answer was wrong because a cited page
 * is, or out of date because a cited page is. Everything else is about the
 * answer, not the pages, and files no report.
 */
export function reportKindFor(reason: AnswerFeedbackReason | null): KnowledgeIssueKind | null {
  if (reason === 'wrong') return 'wrong'
  if (reason === 'outdated') return 'stale'
  return null
}

/** The pages a down-vote may report: cited workspace pages, once each. A web or chat source has no page to report against. */
export function reportablePages(sources: readonly AssistantSource[]): Array<{ documentId: string; title: string; revisionId?: string }> {
  const seen = new Set<string>()
  const out: Array<{ documentId: string; title: string; revisionId?: string }> = []
  for (const s of sources) {
    if (!isPageSource(s) || seen.has(s.documentId)) continue
    seen.add(s.documentId)
    out.push({ documentId: s.documentId, title: s.title, ...(s.revisionId ? { revisionId: s.revisionId } : {}) })
  }
  return out
}

/** One `POST /v1/knowledge-issues` body per reported page: the vote's reason as the kind, its comment as the detail. */
export function issueReportBody(
  page: { documentId: string; revisionId?: string },
  input: { workspaceId: string; kind: KnowledgeIssueKind; query: string; comment: string; surface: KnowledgeIssueSurface },
): Record<string, unknown> {
  const comment = input.comment.trim()
  const question = input.query.trim().slice(0, 500)
  return {
    workspaceId: input.workspaceId,
    documentId: page.documentId,
    ...(page.revisionId ? { revisionId: page.revisionId } : {}),
    kind: input.kind,
    detail: (comment || `Reported from a thumbs-down on an answer.`).slice(0, 4_000),
    evidence: question ? [{ note: `The question was: ${question}` }] : [],
    surface: input.surface,
  }
}
