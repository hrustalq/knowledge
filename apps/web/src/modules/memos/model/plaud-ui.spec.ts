import { describe, expect, it } from 'vitest'
import type { PlaudImportEntry } from '@knowledge/contracts'
import { fromRulesForm, groupPlaudImports, toRulesForm } from './plaud-ui'

const row = (id: string, status: PlaudImportEntry['status']): PlaudImportEntry => ({ id, name: id, startAt: null, durationSeconds: 60, status, memoId: null, error: null, createdAt: '2026-11-10T00:00:00Z' })

describe('groupPlaudImports', () => {
  it('shows what needs the person, what failed and what only Plaud can move; settled rows are gone', () => {
    const q = groupPlaudImports([row('a', 'pending'), row('b', 'waiting'), row('c', 'confirmed'), row('d', 'failed'), row('e', 'imported'), row('f', 'skipped')])
    expect(q.ready.map((r) => r.id)).toEqual(['a'])
    expect(q.failed.map((r) => r.id)).toEqual(['d'])
    expect(q.waiting.map((r) => r.id)).toEqual(['b', 'c'])
  })
})

describe('the rules form', () => {
  const effective = { since: '2026-11-01', minSeconds: 120, confirm: 'ask' as const }

  it('shows the defaults as values and sends blanks as no rule', () => {
    const form = toRulesForm('p1', {}, effective)
    expect(form).toMatchObject({ projectId: 'p1', since: '2026-11-01', minMinutes: '2', nameIncludes: '', confirm: 'ask' })
    expect(fromRulesForm({ ...form, nameIncludes: '  sync ', serial: ' ' })).toEqual({ since: '2026-11-01', minSeconds: 120, nameIncludes: 'sync', confirm: 'ask' })
  })

  it('takes a comma decimal and refuses a length that is not a number', () => {
    const form = toRulesForm(null, { minSeconds: 90, confirm: 'auto' }, effective)
    expect(form.minMinutes).toBe('1.5')
    expect(fromRulesForm({ ...form, minMinutes: '0,5' })?.minSeconds).toBe(30)
    expect(fromRulesForm({ ...form, minMinutes: 'abc' })).toBeNull()
    expect(fromRulesForm({ ...form, minMinutes: '-1' })).toBeNull()
  })
})
