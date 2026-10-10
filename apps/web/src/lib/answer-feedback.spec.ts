import { describe, expect, it } from 'vitest'
import type { AnswerVote } from '@knowledge/contracts'
import {
  canSend,
  issueReportBody,
  optimisticVote,
  reportKindFor,
  reportablePages,
  thumbAction,
  voteBody,
  voteSurface,
} from './answer-feedback'

const up: AnswerVote = { rating: 'up', reason: null, comment: null, createdAt: '2026-10-10T00:00:00Z' }
const down: AnswerVote = { rating: 'down', reason: 'outdated', comment: 'rev 3 says otherwise', createdAt: '2026-10-10T00:00:00Z' }

describe('voteSurface', () => {
  it('is the editor assistant exactly when an editor has registered its draft', () => {
    expect(voteSurface(false)).toBe('assistant')
    expect(voteSurface(true)).toBe('editor-assistant')
  })
})

describe('thumbAction', () => {
  it('toggles against the vote that is already there', () => {
    expect(thumbAction(null, 'up')).toBe('vote-up')
    expect(thumbAction(null, 'down')).toBe('open-down-form')
    expect(thumbAction(up, 'up')).toBe('retract')
    expect(thumbAction(down, 'down')).toBe('retract')
    expect(thumbAction(up, 'down')).toBe('open-down-form')
    expect(thumbAction(down, 'up')).toBe('vote-up')
  })
})

describe('canSend', () => {
  it('needs a reason on a thumbs-down only', () => {
    expect(canSend('up', null)).toBe(true)
    expect(canSend('down', null)).toBe(false)
    expect(canSend('down', 'wrong')).toBe(true)
  })
})

describe('voteBody', () => {
  it('sends the surface with a message vote and drops empty optionals', () => {
    expect(voteBody({ kind: 'message', messageId: 'm' }, { rating: 'up', reason: null, comment: '  ' }, 'editor-assistant')).toEqual({
      rating: 'up',
      surface: 'editor-assistant',
    })
    expect(
      voteBody({ kind: 'message', messageId: 'm' }, { rating: 'down', reason: 'wrong', comment: ' nope ' }, 'assistant'),
    ).toEqual({ rating: 'down', reason: 'wrong', comment: 'nope', surface: 'assistant' })
  })

  it('sends what the voter saw for a one-shot /ask answer, bounded and deduplicated', () => {
    const body = voteBody(
      {
        kind: 'ask',
        workspaceId: 'ws',
        query: 'q'.repeat(5_000),
        answer: 'a'.repeat(2_000),
        sources: [
          { documentId: 'd1', title: 'One' },
          { documentId: 'd1', title: 'One again' },
          { documentId: 'd2', title: 'Two' },
        ],
      },
      { rating: 'down', reason: 'no-answer', comment: '' },
      'ask',
    )
    expect(body).toMatchObject({ rating: 'down', reason: 'no-answer', workspaceId: 'ws', citedDocumentIds: ['d1', 'd2'] })
    expect(body).not.toHaveProperty('surface')
    expect((body.query as string).length).toBe(4_000)
    expect((body.answerExcerpt as string).length).toBe(1_000)
  })
})

describe('optimisticVote', () => {
  it('is the draft as the thumbs will show it', () => {
    expect(optimisticVote({ rating: 'down', reason: 'unclear', comment: ' x ' })).toMatchObject({
      rating: 'down',
      reason: 'unclear',
      comment: 'x',
    })
    expect(optimisticVote({ rating: 'up', reason: null, comment: '' }).comment).toBeNull()
  })
})

// ---- a down-vote that names its pages (docs/features/38, phase 3) ---------

describe('reportKindFor', () => {
  it('only wrong and outdated name a page', () => {
    expect(reportKindFor('wrong')).toBe('wrong')
    expect(reportKindFor('outdated')).toBe('stale')
    for (const r of ['incomplete', 'irrelevant-sources', 'no-answer', 'unclear', 'other', null] as const) {
      expect(reportKindFor(r)).toBeNull()
    }
  })
})

describe('reportablePages', () => {
  it('is the cited workspace pages once each, never a web source', () => {
    const pages = reportablePages([
      { documentId: 'd1', title: 'A', revisionId: 'r1' },
      { documentId: 'd1', title: 'A again' },
      { kind: 'web', url: 'https://x.test', site: 'x.test', title: 'W', fetchedAt: '2026-10-10T00:00:00Z' },
      { documentId: 'd2', title: 'B' },
    ])
    expect(pages).toEqual([{ documentId: 'd1', title: 'A', revisionId: 'r1' }, { documentId: 'd2', title: 'B' }])
  })
})

describe('issueReportBody', () => {
  it("carries the vote's reason as the kind, its comment as the detail and the question as a note", () => {
    const body = issueReportBody(
      { documentId: 'd1', revisionId: 'r1' },
      { workspaceId: 'ws', kind: 'stale', query: 'How long do sessions last?', comment: ' Says 30 days, it is 7. ', surface: 'assistant' },
    )
    expect(body).toEqual({
      workspaceId: 'ws',
      documentId: 'd1',
      revisionId: 'r1',
      kind: 'stale',
      detail: 'Says 30 days, it is 7.',
      evidence: [{ note: 'The question was: How long do sessions last?' }],
      surface: 'assistant',
    })
  })

  it('says where it came from when the voter left no comment', () => {
    const body = issueReportBody({ documentId: 'd1' }, { workspaceId: 'ws', kind: 'wrong', query: '', comment: '', surface: 'ask' })
    expect(body.detail).toMatch(/thumbs-down/)
    expect(body.evidence).toEqual([])
    expect(body).not.toHaveProperty('revisionId')
  })
})
