import { parseEmbedUrl, type EmbedItem, type EmbedRef } from '@knowledge/contracts/embeds'

/**
 * One embed item as a tile (#470): what the editor's node view and the read
 * view both draw, so a group looks the same read and edited. Store-free on
 * purpose, like the rest of `lib/`.
 */
export interface EmbedTile {
  /** Null when the URL is not http(s): the tile is text, never a link. */
  href: string | null
  caption: string
  /** The provider item, when one claims the URL. */
  ref: EmbedRef | null
  /** The provider and node for a claimed URL, else the host. */
  meta: string
  /** A provider item with no pinned version (kept, shown as a link, warned). */
  unpinned: boolean
}

export function embedTile(item: EmbedItem, wholeFile: string): EmbedTile {
  const ref = parseEmbedUrl(item.url)
  const href = /^https?:\/\//i.test(item.url) ? item.url : null
  const meta = ref
    ? `${ref.board ? 'FigJam' : 'Figma'} · ${ref.nodeId ?? wholeFile}`
    : (href && safeHost(href)) || item.url
  return { href, caption: item.caption, ref, meta, unpinned: !!ref && !item.version }
}

function safeHost(href: string): string | null {
  try {
    return new URL(href).host
  } catch {
    return null
  }
}

/**
 * Figma's own embed of a canonical URL, mounted only when a member asks for it
 * ("Open live"). Never part of sanitized HTML: the node view builds the iframe
 * itself, from a URL `parseEmbedUrl` already accepted.
 */
export function figmaLiveUrl(url: string): string {
  return `https://www.figma.com/embed?embed_host=knowledge&url=${encodeURIComponent(url)}`
}
