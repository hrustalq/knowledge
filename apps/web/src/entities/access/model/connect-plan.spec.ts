import { describe, expect, it } from 'vitest'
import { CONNECT_ROLES, scopeFor, stepsFor, toolsetsFor, workflowsFor } from './connect-plan'

describe('connect plan', () => {
  it('every role starts from asking, and seeds a copy the caller may change', () => {
    for (const role of CONNECT_ROLES) expect(workflowsFor(role)[0]).toBe('ask')
    workflowsFor('developer').push('qa')
    expect(workflowsFor('developer')).toEqual(['ask', 'code', 'capture'])
  })

  it('derives the narrowest scope that does every workflow', () => {
    expect(scopeFor(['ask'])).toBe('read')
    expect(scopeFor(['ask', 'code'])).toBe('read')
    expect(scopeFor(['ask', 'capture'])).toBe('capture')
    expect(scopeFor(['ask', 'capture', 'author'])).toBe('write')
    expect(scopeFor(['qa'])).toBe('write')
    expect(scopeFor([])).toBe('read')
  })

  it('suggests each toolset once, never core', () => {
    expect(toolsetsFor(['ask', 'code'])).toEqual(['graph', 'code', 'api-reference'])
    expect(toolsetsFor(['author', 'review'])).toEqual(['authoring', 'quality', 'drafts', 'review', 'conflicts'])
    expect(toolsetsFor(['ask', 'code', 'author', 'review', 'capture', 'qa'])).not.toContain('core')
  })

  it('shows only the steps that apply', () => {
    const claude = { skillDir: '.claude/skills', captureKit: 'claude-code' }
    const desktop = { skillDir: null, captureKit: null }
    expect(stepsFor({ needsKey: true, client: claude, workflows: ['ask'] })).toEqual([
      'role', 'client', 'workflow', 'key', 'preferences', 'configure', 'skill', 'verify',
    ])
    // Dev mode has no key; a client with no skill dir and no kit has nothing to prefer.
    expect(stepsFor({ needsKey: false, client: desktop, workflows: ['ask', 'capture'] })).toEqual([
      'role', 'client', 'workflow', 'configure', 'skill', 'verify',
    ])
    // A kit alone is a preference, but only once capturing was chosen.
    const kitOnly = { skillDir: null, captureKit: 'cursor' }
    expect(stepsFor({ needsKey: true, client: kitOnly, workflows: ['capture'] })).toContain('preferences')
    expect(stepsFor({ needsKey: true, client: kitOnly, workflows: ['ask'] })).not.toContain('preferences')
    // Before a client is chosen the list does not shrink under the person.
    expect(stepsFor({ needsKey: true, client: null, workflows: [] })).toContain('preferences')
  })
})
