import { describe, expect, it } from 'vitest'
import type { AssistantPromptField, Blueprint } from '@knowledge/contracts'
import { answersOf, answerText, roundComplete, seedOf, withTerms } from './interview'

const audience: AssistantPromptField = {
  type: 'choice',
  name: 'audience',
  label: 'Who reads it?',
  options: [
    { value: 'eng', label: 'Engineers', recommended: true },
    { value: 'support', label: 'Support' },
  ],
}
const recurs: AssistantPromptField = {
  type: 'checklist',
  name: 'recurs',
  label: 'What recurs?',
  options: [
    { value: 'adr', label: 'Decisions' },
    { value: 'inc', label: 'Incidents' },
  ],
}
const open: AssistantPromptField = { type: 'choice', name: 'tone', label: 'Tone?', options: [{ value: 'a', label: 'A' }] }
const questions = [audience, recurs]

describe('interview answers', () => {
  it('sends the suggestions as they stand, and typed words over a choice or beside the ticks', () => {
    const { values } = seedOf({ questions })
    expect(answersOf(questions, values, {})).toEqual({ audience: 'eng', recurs: null })
    expect(answersOf(questions, { ...values, recurs: ['inc'] }, { audience: 'Partners', recurs: 'Releases' })).toEqual({
      audience: 'Partners',
      recurs: ['inc', 'Releases'],
    })
  })

  it('holds a choice with no suggestion until it is answered', () => {
    const { values } = seedOf({ questions: [open] })
    expect(roundComplete([open], values, {})).toBe(false)
    expect(roundComplete([open], values, { tone: 'Dry' })).toBe(true)
    expect(roundComplete(questions, seedOf({ questions }).values, {})).toBe(true)
  })

  it('reads a sent round back into the same controls', () => {
    const answers = { audience: 'Partners', recurs: ['adr', 'Releases'] }
    expect(seedOf({ questions, answers })).toEqual({
      values: { audience: '', recurs: ['adr'] },
      others: { audience: 'Partners', recurs: 'Releases' },
    })
    expect(answersOf(questions, seedOf({ questions, answers }).values, seedOf({ questions, answers }).others)).toEqual(answers)
  })

  it('writes an answer as labels, own words as typed', () => {
    expect(answerText(recurs, ['adr', 'Releases'], 'Skipped')).toBe('Decisions, Releases')
    expect(answerText(recurs, null, 'Skipped')).toBe('Skipped')
  })
})

describe('withTerms', () => {
  it('adds the drafted terms to the glossary, case-folded, keeping the ones already there', () => {
    const bp: Blueprint = { name: { en: 'X' }, tree: [], conventions: { glossary: [{ term: 'Invoice', definition: 'old' }] } }
    const next = withTerms(bp, [
      { term: 'invoice ', definition: 'new' },
      { term: 'Payout', definition: 'money out' },
    ])
    expect(next.conventions?.glossary).toEqual([
      { term: 'Invoice', definition: 'old' },
      { term: 'Payout', definition: 'money out' },
    ])
    expect(withTerms({ name: { en: 'X' }, tree: [] }, [])).toEqual({ name: { en: 'X' }, tree: [] })
  })
})
