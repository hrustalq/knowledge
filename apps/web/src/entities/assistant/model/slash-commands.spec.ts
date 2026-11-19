import { describe, expect, it } from 'vitest'
import { COMPOSER_COMMANDS, slashState } from './slash-commands'

const all = COMPOSER_COMMANDS
const viewer = all.filter((c) => c !== 'agent')

describe('slashState', () => {
  it('lists commands by prefix, the exact name first', () => {
    expect(slashState('/mo', all)).toEqual({ step: 'command', matches: ['model'] })
    expect(slashState('/agent', all)).toEqual({ step: 'command', matches: ['agent', 'agent-key'] })
    expect(slashState('/', all)?.step).toBe('command')
  })

  it('a space after a command that takes a value opens its list', () => {
    expect(slashState('/model ', all)).toEqual({ step: 'arg', command: 'model', query: '' })
    expect(slashState('/page Run book', all)).toEqual({ step: 'arg', command: 'page', query: 'Run book' })
  })

  it('offers only what the caller may run: a viewer never sees /agent', () => {
    expect(slashState('/agent', viewer)).toEqual({ step: 'command', matches: ['agent-key'] })
    expect(slashState('/agent ', viewer)).toBeNull()
  })

  it('anything that is not a command is sent as typed', () => {
    for (const text of ['/etc/hosts is broken', '/usr bin', '/ask why', '/model\nnext line', 'hello /model', '/Model']) {
      expect(slashState(text, all), text).toBeNull()
    }
  })

  it('every web command is in the shared catalogue', () => {
    expect(all).toEqual(['new', 'ask', 'agent', 'model', 'agent-key', 'skill', 'page', 'capture', 'help'])
  })
})
