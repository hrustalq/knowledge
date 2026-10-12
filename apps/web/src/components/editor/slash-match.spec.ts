import { describe, expect, it } from 'vitest'
import { slashItemMatches, TEMPLATE_SLASH_KEYWORDS } from './slash-match'

describe('the /template slash command', () => {
  // Labels are translated, keywords are not: the ru words have to be carried.
  const item = (label: string) => ({ label, keywords: TEMPLATE_SLASH_KEYWORDS, group: 'Structure' })

  it('answers to its name and to the kinds of page the built-ins cover', () => {
    for (const query of ['template', 'adr', 'RFC', 'postmortem', 'runbook']) {
      expect(slashItemMatches(item('Template'), query)).toBe(true)
    }
  })

  it('answers to Russian words even under an English label', () => {
    expect(slashItemMatches(item('Template'), 'шаблон')).toBe(true)
    expect(slashItemMatches(item('Template'), 'шаб')).toBe(true)
    expect(slashItemMatches(item('Шаблон'), 'template')).toBe(true)
  })

  it('does not answer to unrelated text', () => {
    expect(slashItemMatches(item('Template'), 'mermaid')).toBe(false)
  })
})
