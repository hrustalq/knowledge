/**
 * URL and text builders for a page's AI actions menu (issue #68). Pure: no DOM,
 * no clipboard, no `window`. The menu component runs these on click, so the
 * SSR pass never touches them.
 *
 * Vendor deeplink formats (`chatgpt.com/?q=`, `claude.ai/new?q=`, Cursor's
 * `cursor://anysphere.cursor-deeplink/…`) are not formal APIs and may change or
 * cap URL length. They live only in this file, and every "Open in…" has a
 * clipboard fallback (`openInVendor` → `{ kind: 'clipboard' }`), so a vendor
 * that changes its format degrades to "paste it yourself" rather than breaking.
 *
 * Security: nothing built here ever carries an API key. The agent link and the
 * MCP config use the `KNOWLEDGE_API_KEY` placeholder; the key stays in the
 * agent's environment, never in a URL where logs and history would keep it.
 */

import { EXTERNAL_AI_ACTIONS, type AiActionId } from '@knowledge/contracts/content'
import { KEY_ENV } from './mcp-clients'

/** Vendor URLs past this length are refused by some browsers and proxies. */
export const MAX_VENDOR_URL = 8000

export type ExternalVendor = 'chatgpt' | 'claude' | 'cursor'

export const VENDOR_FOR: Record<ExternalVendor, AiActionId> = {
  chatgpt: 'open-chatgpt',
  claude: 'open-claude',
  cursor: 'open-cursor',
}

export interface PageRef {
  id: string
  title: string
}

const trimBase = (webBase: string) => webBase.replace(/\/+$/, '')

/** `{web}/documents/{id}.md` — the URL agents fetch and `llms.txt` links to. */
export function pageMarkdownUrl(webBase: string, id: string, opts: { frontmatter?: boolean } = {}): string {
  return `${trimBase(webBase)}/documents/${id}.md${opts.frontmatter ? '?frontmatter=1' : ''}`
}

/** The human page URL. */
export function pageUrl(webBase: string, id: string): string {
  return `${trimBase(webBase)}/documents/${id}`
}

/**
 * The prompt an "Open in…" action carries: an instruction, then the page.
 * A page longer than `maxChars` is cut at the last line break before the limit
 * and ends with a footer naming the full page, so the model knows it is reading
 * part of something and where the rest is.
 */
export function chatPrompt(
  page: PageRef & { markdown: string },
  opts: { webBase: string; maxChars: number },
): { text: string; truncated: boolean } {
  const url = pageUrl(opts.webBase, page.id)
  const head = `Here is a page from our knowledge base, "${page.title}" (${url}). Read it, then answer my questions about it.\n\n---\n\n`
  const body = page.markdown.trim()
  const budget = Math.max(0, opts.maxChars - head.length)
  if (body.length <= budget) return { text: `${head}${body}\n`, truncated: false }

  const footer = `\n\n…truncated. The full page is at ${url}`
  const room = Math.max(0, budget - footer.length)
  const cut = body.lastIndexOf('\n', room)
  const kept = body.slice(0, cut > room / 2 ? cut : room).trimEnd()
  return { text: `${head}${kept}${footer}\n`, truncated: true }
}

export function chatgptUrl(prompt: string): string {
  return `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`
}

export function claudeUrl(prompt: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`
}

export function cursorPromptUrl(prompt: string): string {
  return `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`
}

const VENDOR_URL: Record<ExternalVendor, (prompt: string) => string> = {
  chatgpt: chatgptUrl,
  claude: claudeUrl,
  cursor: cursorPromptUrl,
}

/**
 * What an "Open in {vendor}" click does: open a URL with the page inline, or,
 * when that URL would be too long (or the page was truncated for the prompt),
 * copy the full prompt so the reader pastes it into the vendor's chat.
 */
export function openInVendor(
  vendor: ExternalVendor,
  page: PageRef & { markdown: string },
  opts: { webBase: string; maxChars: number },
): { kind: 'url'; url: string } | { kind: 'clipboard'; text: string } {
  const prompt = chatPrompt(page, opts)
  if (prompt.truncated) {
    return { kind: 'clipboard', text: chatPrompt(page, { ...opts, maxChars: Number.POSITIVE_INFINITY }).text }
  }
  const url = VENDOR_URL[vendor](prompt.text)
  if (url.length > MAX_VENDOR_URL) return { kind: 'clipboard', text: prompt.text }
  return { kind: 'url', url }
}

/**
 * The page's `.md` URL plus how to fetch it. Never a key: the curl line names
 * the env var, so pasting it into a chat or a ticket leaks nothing.
 */
export function agentLink(webBase: string, id: string): string {
  const url = pageMarkdownUrl(webBase, id)
  return `${url}\nFetch with: curl -H "Authorization: Bearer $${KEY_ENV}" ${url}\n`
}

/**
 * Cursor's one-click MCP install link. `config` is the server entry Cursor
 * would write into mcp.json, base64-encoded as the deeplink expects.
 */
export function cursorMcpInstallUrl(name: string, config: Record<string, unknown>): string {
  const json = JSON.stringify(config)
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(b64)}`
}

/** Whether an action sends the page to a third party — the ones the setting hides. */
export function isExternal(id: AiActionId): boolean {
  return EXTERNAL_AI_ACTIONS.has(id)
}
