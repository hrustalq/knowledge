import { describe, expect, it } from 'vitest'
import { SOURCE_VERIFICATION_STATES } from '@knowledge/contracts'
import {
  INTERVAL_CHOICES,
  flagSourceWho,
  intervalFromKey,
  intervalKey,
  needsAttention,
  verificationDotClass,
} from './verification-ui'

describe('verification-ui', () => {
  it('marks only the states that ask for a look', () => {
    expect(needsAttention('verified')).toBe(false)
    expect(needsAttention('unverified')).toBe(false)
    expect(needsAttention(undefined)).toBe(false)
    for (const s of ['edited', 'expired', 'requested', 'outdated', 'flagged'] as const) {
      expect(needsAttention(s)).toBe(true)
    }
  })

  it('gives every state a dot colour', () => {
    for (const s of SOURCE_VERIFICATION_STATES) {
      expect(verificationDotClass(s)).toMatch(/^bg-/)
    }
    expect(verificationDotClass('outdated')).toBe('bg-destructive')
    expect(verificationDotClass('expired')).toBe('bg-amber-500')
    expect(verificationDotClass('verified')).toBe('bg-emerald-500')
  })

  it('round-trips every interval choice through the menu key', () => {
    for (const choice of INTERVAL_CHOICES) {
      expect(intervalFromKey(intervalKey(choice))).toBe(choice)
    }
    expect(intervalKey(undefined)).toBe('default')
    // Garbage from a stale menu value falls back to the workspace default.
    expect(intervalFromKey('-3')).toBeNull()
    expect(intervalFromKey('abc')).toBeNull()
  })

  it('names who set a flag by role, not by run owner', () => {
    expect(flagSourceWho({ kind: 'person', by: 'u1', at: '2026-10-11T00:00:00Z' })).toBe('person')
    expect(flagSourceWho({ kind: 'person', at: '2026-10-11T00:00:00Z' })).toBe('someone')
    expect(flagSourceWho({ kind: 'drift', by: 'owner', runId: 'r', url: 'https://x', at: '2026-10-11T00:00:00Z' })).toBe('sentinel')
    expect(flagSourceWho({ kind: 'curator', by: 'owner', at: '2026-10-11T00:00:00Z' })).toBe('curator')
    expect(flagSourceWho({ kind: 'mcp', by: 'owner', at: '2026-10-11T00:00:00Z' })).toBe('mcp')
    expect(flagSourceWho(null)).toBe('someone')
  })
})
