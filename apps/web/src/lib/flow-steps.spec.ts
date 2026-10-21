import { describe, expect, it } from 'vitest'
import type { AssistantFlowAnswer, AssistantMessageInfo } from '@knowledge/contracts'
import { answerTurns, flowSteps } from './flow-steps'

type M = Pick<AssistantMessageInfo, 'id' | 'role' | 'prompt' | 'answer'>

let seq = 0
const ask = (questionId: string): M => ({
  id: `a${++seq}`,
  role: 'assistant',
  prompt: { kind: 'form', question: questionId, fields: [], flow: 'capture-decision', questionId },
})
const reply = (questionId: string, value: AssistantFlowAnswer['value']): M => ({
  id: `u${++seq}`,
  role: 'user',
  prompt: null,
  answer: { flow: 'capture-decision', questionId, value },
})
const typed = (): M => ({ id: `u${++seq}`, role: 'user', prompt: null })

describe('flowSteps', () => {
  it('marks answered steps and offers Change only on the one before the open question', () => {
    const msgs = [ask('project'), reply('project', 'p1'), ask('relatedPage'), reply('relatedPage', 'd1'), ask('reviewer')]
    const s = flowSteps(msgs)
    expect(s.get(msgs[0].id)).toEqual({ answer: msgs[1].answer, superseded: false, changeable: false })
    expect(s.get(msgs[2].id)).toEqual({ answer: msgs[3].answer, superseded: false, changeable: true })
    expect(s.get(msgs[4].id)).toEqual({ answer: null, superseded: false, changeable: false })
  })

  it('shows a changed answer, and the question it pre-empted, as superseded', () => {
    const msgs = [ask('relatedPage'), reply('relatedPage', 'd1'), ask('reviewer'), reply('relatedPage', 'none')]
    const s = flowSteps(msgs)
    expect(s.get(msgs[0].id)).toMatchObject({ superseded: true, changeable: false })
    expect(s.get(msgs[2].id)).toEqual({ answer: null, superseded: true, changeable: false })
  })

  it('keeps an answer standing when the run was left by typing', () => {
    const msgs = [ask('project'), reply('project', 'p1'), ask('relatedPage'), typed(), ask('project'), reply('project', 'p2')]
    const s = flowSteps(msgs)
    expect(s.get(msgs[0].id)).toMatchObject({ superseded: false })
    expect(s.get(msgs[2].id)).toEqual({ answer: null, superseded: false, changeable: false })
  })

  it('ties a changed answer to the question it answers, not the one it was posted under', () => {
    const msgs = [ask('relatedPage'), reply('relatedPage', 'd1'), ask('reviewer'), reply('relatedPage', 'none')]
    const a = answerTurns(msgs)
    expect(a.get(msgs[1].id)).toEqual({ prompt: msgs[0].prompt, superseded: true })
    expect(a.get(msgs[3].id)).toEqual({ prompt: msgs[0].prompt, superseded: false })
  })
})
