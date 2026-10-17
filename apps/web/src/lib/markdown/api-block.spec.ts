import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '@/lib/markdown/serialize'
import { SANITIZE_CONFIG } from '@/lib/markdown/render'

// The API block's link to a spec operation (#78) rides in stored markdown as
// `data-kn-op`, which the ingestion worker reads back as an IMPLEMENTS fact
// (apps/api/src/common/relations.ts → readApiOperationRefs). These pin the
// writer's half of that contract.
describe('an API block linked to a spec operation', () => {
  const block = (op?: string) =>
    `<div data-kn-api="POST" data-kn-path="/invoices"${op === undefined ? '' : ` data-kn-op="${op}"`}>` +
    '<h3>POST /invoices</h3><div data-kn-api-section="summary"><p>Bills a customer.</p></div></div>'

  it('writes the operation key on the wrapper, beside method and path', () => {
    const md = htmlToMarkdown(block('op:billing-api:post-/invoices'))
    expect(md).toContain('<div data-kn-api="POST" data-kn-path="/invoices" data-kn-op="op:billing-api:post-/invoices">')
    expect(md).toContain('Bills a customer.')
  })

  it('escapes what could break out of the attribute', () => {
    const md = htmlToMarkdown(block('channel:events:a&amp;b&quot;c'))
    expect(md).toContain('data-kn-op="channel:events:a&amp;b&quot;c"')
  })

  it('leaves an unlinked block exactly as it was written before', () => {
    expect(htmlToMarkdown(block())).toContain('<div data-kn-api="POST" data-kn-path="/invoices">')
  })

  it('survives the read view sanitizer', () => {
    expect(SANITIZE_CONFIG.ADD_ATTR).toContain('data-kn-op')
  })
})
