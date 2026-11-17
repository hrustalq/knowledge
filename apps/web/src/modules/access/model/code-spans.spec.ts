import { describe, expect, it } from 'vitest'
import { codeSpans } from './code-spans'

describe('codeSpans', () => {
  it('marks the text between backticks as code', () => {
    expect(codeSpans('Check with `qwen mcp list`, then `/mcp`.')).toEqual([
      { text: 'Check with ', code: false },
      { text: 'qwen mcp list', code: true },
      { text: ', then ', code: false },
      { text: '/mcp', code: true },
      { text: '.', code: false },
    ])
  })
  it('leaves text without backticks whole', () => {
    expect(codeSpans('plain')).toEqual([{ text: 'plain', code: false }])
  })
})
