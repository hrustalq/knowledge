import { describe, expect, it } from 'vitest'
import { titleFor } from './document-title'

describe('titleFor', () => {
  it('names a page and its project', () => {
    const crumbs = [{ label: 'Billing', to: '/projects/p' }, { label: 'Pages', to: '/documents' }, { label: 'Webhooks', to: '/documents/d' }]
    expect(titleFor(crumbs)).toBe('Webhooks · Billing · Knowledge')
  })

  it('keeps the page being edited', () => {
    const crumbs = [{ label: 'Billing' }, { label: 'Pages' }, { label: 'Webhooks' }, { label: 'Edit', action: true }]
    expect(titleFor(crumbs)).toBe('Edit · Webhooks · Billing · Knowledge')
  })

  it('never names a restricted page, because the trail does not', () => {
    const crumbs = [{ label: 'Billing' }, { label: 'Pages' }, { label: 'Restricted page', restricted: true }, { label: 'Child' }]
    expect(titleFor(crumbs)).toBe('Child · Billing · Knowledge')
    expect(titleFor([{ label: 'Billing' }, { label: 'Pages' }])).toBe('Pages · Billing · Knowledge')
  })

  it('names a merge request and a settings section', () => {
    expect(titleFor([{ label: 'Merge requests', to: '/merge-requests' }, { label: 'Fix webhooks' }])).toBe(
      'Fix webhooks · Merge requests · Knowledge',
    )
    expect(titleFor([{ label: 'Settings', to: '/settings' }, { label: 'AI' }])).toBe('AI · Settings · Knowledge')
  })

  it('a one-crumb trail and no trail', () => {
    expect(titleFor([{ label: 'Merge requests' }])).toBe('Merge requests · Knowledge')
    expect(titleFor([])).toBe('Knowledge')
  })
})
