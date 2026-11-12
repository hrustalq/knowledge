import { describe, expect, it } from 'vitest'
import { workingBranchAsk } from './working-branch'

describe('workingBranchAsk (#958)', () => {
  const page = { requestedBranch: null, isDraftPage: false }
  it('review: the working branch, created on first ask', () => {
    expect(workingBranchAsk({ ...page, mode: 'review' })).toBe('mine')
  })
  it('direct: only a draft that already exists, else the default branch', () => {
    expect(workingBranchAsk({ ...page, mode: 'direct' })).toBe('existing')
  })
  it('a ?branch= link edits the branch it names, in both modes', () => {
    expect(workingBranchAsk({ ...page, requestedBranch: 'fix', mode: 'review' })).toBe('none')
    expect(workingBranchAsk({ ...page, requestedBranch: 'fix', mode: 'direct' })).toBe('none')
  })
  it('a private draft page has no working branch', () => {
    expect(workingBranchAsk({ ...page, isDraftPage: true, mode: 'review' })).toBe('none')
  })
})
