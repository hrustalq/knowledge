import { describe, expect, it } from 'vitest'
import { AI_ACTION_IDS, EXTERNAL_AI_ACTIONS, visibleAiActions } from '@knowledge/contracts/content'
import {
  MAX_VENDOR_URL,
  agentLink,
  chatPrompt,
  chatgptUrl,
  claudeUrl,
  cursorMcpInstallUrl,
  cursorPromptUrl,
  isExternal,
  openInVendor,
  pageMarkdownUrl,
  pageUrl,
} from './ai-actions'

const WEB = 'https://kb.example.com/'
const ID = '3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f'
const page = (markdown: string) => ({ id: ID, title: 'Billing', markdown })

describe('page URLs', () => {
  it('builds the .md and page URLs without a doubled slash', () => {
    expect(pageMarkdownUrl(WEB, ID)).toBe(`https://kb.example.com/documents/${ID}.md`)
    expect(pageMarkdownUrl(WEB, ID, { frontmatter: true })).toBe(`https://kb.example.com/documents/${ID}.md?frontmatter=1`)
    expect(pageUrl('https://kb.example.com', ID)).toBe(`https://kb.example.com/documents/${ID}`)
  })
})

describe('chatPrompt', () => {
  it('embeds a short page whole', () => {
    const p = chatPrompt(page('# Billing\n\nInvoices go out monthly.'), { webBase: WEB, maxChars: 6000 })
    expect(p.truncated).toBe(false)
    expect(p.text).toContain('"Billing"')
    expect(p.text).toContain(`https://kb.example.com/documents/${ID}`)
    expect(p.text).toContain('Invoices go out monthly.')
  })

  it('cuts a long page on a line break, within the limit, with a footer naming the full page', () => {
    const md = Array.from({ length: 400 }, (_, i) => `Line ${i} of the page.`).join('\n')
    const p = chatPrompt(page(md), { webBase: WEB, maxChars: 1000 })
    expect(p.truncated).toBe(true)
    expect(p.text.length).toBeLessThanOrEqual(1001)
    expect(p.text).toMatch(/…truncated\. The full page is at https:\/\/kb\.example\.com\/documents\//)
    // No half line before the footer.
    expect(p.text).toMatch(/of the page\.\n\n…truncated/)
  })
})

describe('vendor URLs', () => {
  it('puts the prompt in the query, encoded', () => {
    expect(chatgptUrl('a b&c')).toBe('https://chatgpt.com/?q=a%20b%26c')
    expect(claudeUrl('a b&c')).toBe('https://claude.ai/new?q=a%20b%26c')
    expect(cursorPromptUrl('a b')).toBe('cursor://anysphere.cursor-deeplink/prompt?text=a%20b')
  })
})

describe('openInVendor', () => {
  it('opens a URL for a short page', () => {
    const r = openInVendor('claude', page('Short.'), { webBase: WEB, maxChars: 6000 })
    expect(r.kind).toBe('url')
    if (r.kind === 'url') expect(r.url.startsWith('https://claude.ai/new?q=')).toBe(true)
  })

  it('falls back to the clipboard with the whole page when the page is over the inline limit', () => {
    const md = 'x'.repeat(10_000)
    const r = openInVendor('chatgpt', page(md), { webBase: WEB, maxChars: 6000 })
    expect(r.kind).toBe('clipboard')
    if (r.kind === 'clipboard') {
      expect(r.text).toContain(md)
      expect(r.text).not.toContain('truncated')
    }
  })

  it('falls back to the clipboard when encoding makes the URL too long', () => {
    // Cyrillic triples under percent-encoding (2 UTF-8 bytes → 6 chars).
    const md = 'ж'.repeat(3000)
    const r = openInVendor('chatgpt', page(md), { webBase: WEB, maxChars: 6000 })
    expect(chatgptUrl(md).length).toBeGreaterThan(MAX_VENDOR_URL)
    expect(r.kind).toBe('clipboard')
  })
})

describe('no key leakage', () => {
  it('agent link names the env var, never a key, and has no token in the URL', () => {
    const text = agentLink(WEB, ID)
    expect(text).toContain(`https://kb.example.com/documents/${ID}.md`)
    expect(text).toContain('Authorization: Bearer $KNOWLEDGE_API_KEY')
    expect(text).not.toMatch(/token=|kn_[A-Za-z0-9]/)
  })

  it('Cursor install link round-trips its config and carries no key', () => {
    const config = { url: 'https://kb.example.com/api/v1/mcp', headers: { Authorization: 'Bearer ${env:KNOWLEDGE_API_KEY}' } }
    const url = cursorMcpInstallUrl('knowledge', config)
    const b64 = decodeURIComponent(new URL(url.replace('cursor://', 'https://')).searchParams.get('config') ?? '')
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
    expect(JSON.parse(decoded)).toEqual(config)
    expect(url).toContain('name=knowledge')
  })
})

describe('action gating', () => {
  it('hides exactly the external actions when switched off', () => {
    const all = visibleAiActions(true)
    expect(all).toEqual([...AI_ACTION_IDS])
    const off = visibleAiActions(false)
    expect(off).toEqual(AI_ACTION_IDS.filter((id) => !EXTERNAL_AI_ACTIONS.has(id)))
    expect(off).toContain('copy-markdown')
    expect(off).not.toContain('open-chatgpt')
    expect(off).not.toContain('open-claude')
    expect(off).not.toContain('open-cursor')
  })

  it('isExternal agrees with the contracts set', () => {
    for (const id of AI_ACTION_IDS) expect(isExternal(id)).toBe(EXTERNAL_AI_ACTIONS.has(id))
  })
})
