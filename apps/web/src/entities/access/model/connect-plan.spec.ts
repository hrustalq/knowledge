import { describe, expect, it } from 'vitest'
import { CONNECT_ROLES, hasPreferences, scopeFor, stepsFor, toolsetsFor, workflowsFor } from './connect-plan'

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

  it('keeps the step count fixed; only the key step depends on the server', () => {
    expect(stepsFor({ needsKey: true })).toEqual(['role', 'client', 'workflow', 'key', 'preferences', 'configure', 'skill', 'verify'])
    expect(stepsFor({ needsKey: false })).toEqual(['role', 'client', 'workflow', 'preferences', 'configure', 'skill', 'verify'])
  })

  it('has preferences only for a stackable skill dir, a project config, or a kit once capturing was chosen', () => {
    const c = { stackable: false, captureKit: null, project: false }
    expect(hasPreferences({ client: { ...c, stackable: true }, workflows: ['ask'] })).toBe(true)
    expect(hasPreferences({ client: c, workflows: ['capture'] })).toBe(false)
    expect(hasPreferences({ client: { ...c, captureKit: 'cursor' }, workflows: ['capture'] })).toBe(true)
    expect(hasPreferences({ client: { ...c, captureKit: 'cursor' }, workflows: ['ask'] })).toBe(false)
    // "For this repository" is a choice even for a client with no skills dir and no kit (#1348).
    expect(hasPreferences({ client: { ...c, project: true }, workflows: ['ask'] })).toBe(true)
    expect(hasPreferences({ client: null, workflows: [] })).toBe(false)
  })
})
