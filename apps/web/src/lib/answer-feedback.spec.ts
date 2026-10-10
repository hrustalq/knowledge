import { describe, expect, it } from 'vitest'
import type { AnswerVote } from '@knowledge/contracts'
import { canSend, optimisticVote, thumbAction, voteBody, voteSurface } from './answer-feedback'

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
