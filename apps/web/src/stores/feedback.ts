import { defineStore } from 'pinia'
import type {
  AnswerSurface,
  AnswerVote,
  AssistantMessageInfo,
  DeleteAnswerFeedbackResponse,
  KnowledgeIssueInfo,
  KnowledgeIssueKind,
  KnowledgeIssueSurface,
  ReportKnowledgeIssueResponse,
  SetAnswerFeedbackResponse,
  UpdateKnowledgeIssueResponse,
} from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { issueReportBody, optimisticVote, voteBody, type FeedbackTarget, type VoteDraft } from '@/lib/answer-feedback'

/**
 * The caller's votes on answers (docs/features/38, phase 2).
 *
 * Keyed by message id: a thread read already carries each reply's vote
 * (`message.feedback`), and this store holds what changed since — a vote just
 * cast, or just taken back — so the thumbs settle the moment they are pressed
 * and the server copy wins on the next read. Workspace- and project-agnostic
 * (a message id is global), so no `rescope()`.
 *
 * One-shot `/ask` answers have no message id and no server-side vote to read
 * back; `voteOnAsk` returns what was stored and the widget keeps it itself.
 *
 * Reports (phase 3) are plain requests with no cache: the page's Issues rail
 * reads them through vue-query and invalidates itself.
 */
export const useFeedbackStore = defineStore('feedback', {
  state: () => ({
    /** Message id → the vote now standing (null = retracted). Absent = whatever the message row says. */
    votes: {} as Record<string, AnswerVote | null>,
    busy: {} as Record<string, boolean>,
  }),
  getters: {
    /** The vote to draw for a reply: what this store knows, else what the thread read said. */
    voteFor:
      (state) =>
      (message: Pick<AssistantMessageInfo, 'id' | 'feedback'>): AnswerVote | null =>
        message.id in state.votes ? state.votes[message.id]! : (message.feedback ?? null),
  },
  actions: {
    /** A thread was (re)read: the server's copy replaces whatever this store remembered. */
    hydrate(messages: readonly AssistantMessageInfo[]) {
      for (const m of messages) if (m.feedback !== undefined) delete this.votes[m.id]
    },

    /**
     * Cast or replace a vote on a persisted reply. Optimistic; rolled back on
     * failure. `surface` is the component's call (it knows whether an editor
     * is mounted); the store does not reach into the assistant store for it,
     * which is also what keeps the two stores from importing each other.
     */
    async vote(messageId: string, draft: VoteDraft, surface: Extract<AnswerSurface, 'assistant' | 'editor-assistant'>): Promise<void> {
      const target: FeedbackTarget = { kind: 'message', messageId }
      const before = this.votes[messageId]
      const had = messageId in this.votes
      this.votes[messageId] = optimisticVote(draft)
      this.busy[messageId] = true
      try {
        const res = await apiFetch<SetAnswerFeedbackResponse>(`/v1/assistant/messages/${messageId}/feedback`, {
          method: 'PUT',
          body: JSON.stringify(voteBody(target, draft, surface)),
        })
        this.votes[messageId] = {
          rating: res.feedback.rating ?? draft.rating,
          reason: res.feedback.reason,
          comment: res.feedback.comment,
          createdAt: res.feedback.createdAt,
        }
      } catch (e) {
        if (had) this.votes[messageId] = before ?? null
        else delete this.votes[messageId]
        throw e
      } finally {
        delete this.busy[messageId]
      }
    },

    /** Take a vote back. Optimistic; rolled back on failure. */
    async retract(messageId: string, current: AnswerVote | null): Promise<void> {
      this.votes[messageId] = null
      this.busy[messageId] = true
      try {
        await apiFetch<DeleteAnswerFeedbackResponse>(`/v1/assistant/messages/${messageId}/feedback`, { method: 'DELETE' })
      } catch (e) {
        this.votes[messageId] = current
        throw e
      } finally {
        delete this.busy[messageId]
      }
    },

    /**
     * File a report against a page (docs/features/38, phase 3). The API folds
     * it into an open issue for the same page and kind, opens a draft merge
     * request, queues a sentinel check, or leaves it open — the response says
     * which, and the caller tells the reporter.
     */
    async reportIssue(body: Record<string, unknown>): Promise<ReportKnowledgeIssueResponse> {
      return apiFetch<ReportKnowledgeIssueResponse>('/v1/knowledge-issues', { method: 'POST', body: JSON.stringify(body) })
    },

    /**
     * A thumbs-down that named its pages: one report per cited page, after the
     * vote itself is stored. Reports are best-effort — a failed one is counted,
     * not thrown, because the vote has already landed and the thumbs should say so.
     */
    async reportCitedPages(
      pages: ReadonlyArray<{ documentId: string; revisionId?: string }>,
      input: { workspaceId: string; kind: KnowledgeIssueKind; query: string; comment: string; surface: KnowledgeIssueSurface },
    ): Promise<{ reported: number; failed: number }> {
      let reported = 0
      let failed = 0
      for (const page of pages) {
        try {
          await this.reportIssue(issueReportBody(page, input))
          reported += 1
        } catch {
          failed += 1
        }
      }
      return { reported, failed }
    },

    /** Close a report by hand — resolved or dismissed. */
    async closeIssue(issueId: string, status: 'resolved' | 'dismissed'): Promise<KnowledgeIssueInfo> {
      const res = await apiFetch<UpdateKnowledgeIssueResponse>(`/v1/knowledge-issues/${issueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      return res.issue
    },

    /** A vote on a one-shot `/ask` answer: stored as its own row, nothing cached here. */
    async voteOnAsk(target: Extract<FeedbackTarget, { kind: 'ask' }>, draft: VoteDraft): Promise<AnswerVote> {
      const res = await apiFetch<SetAnswerFeedbackResponse>('/v1/assistant/ask/feedback', {
        method: 'POST',
        body: JSON.stringify(voteBody(target, draft, 'ask')),
      })
      return {
        rating: res.feedback.rating ?? draft.rating,
        reason: res.feedback.reason,
        comment: res.feedback.comment,
        createdAt: res.feedback.createdAt,
      }
    },
  },
})
