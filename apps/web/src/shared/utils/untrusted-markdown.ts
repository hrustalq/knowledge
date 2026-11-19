/**
 * Model output, made safe to look at (#1099).
 *
 * An assistant answer, an agent's reply in a thread, a workflow draft, a site's
 * Ask answer: text a model wrote after reading content anyone may have
 * written. An image in it loads the moment it renders — mid-stream, before the
 * reader has seen anything — and its URL can carry what the model retrieved
 * under the reader's scope. `finalizeCitations` polices `[S#]` labels only.
 *
 * So untrusted text loads nothing from any host by itself: the trusted rules
 * (`SANITIZE_CONFIG`), every element and attribute that fetches dropped, and an
 * `<img>` kept only when it is one of our attachments (or a `data:` image). Any
 * other image becomes a plain link, which a person has to choose to follow.
 *
 * The work happens on a `<template>`: its content belongs to an inert document,
 * so nothing in it starts loading before it is stripped.
 */
import DOMPurify, { type WindowLike } from 'dompurify'
import { parseAttachmentPath } from '@knowledge/contracts/publishing'
import { SANITIZE_CONFIG } from '@/core/markdown/render'

/** Elements that fetch on render, beyond <img>. DOMPurify compares lowercased names. */
const REMOTE_TAGS = ['picture', 'source', 'video', 'audio', 'track', 'image', 'feimage', 'mglyph']
/** Attributes that fetch on render, beyond src. */
const REMOTE_ATTRS = ['srcset', 'background', 'poster']

const UNTRUSTED_CONFIG = {
  ...SANITIZE_CONFIG,
  FORBID_TAGS: [...SANITIZE_CONFIG.FORBID_TAGS, ...REMOTE_TAGS],
  FORBID_ATTR: [...SANITIZE_CONFIG.FORBID_ATTR, ...REMOTE_ATTRS],
}

/**
 * DOMPurify for the window `doc` belongs to: the server's jsdom one (#1331), or
 * the browser's own when `doc` has none (a detached document, `inertDocument`).
 */
const purifiers = new WeakMap<object, typeof DOMPurify>()
export function purifierFor(doc?: Document): typeof DOMPurify {
  const view = doc?.defaultView
  if (!view) return DOMPurify
  let purify = purifiers.get(view)
  if (!purify) purifiers.set(view, (purify = DOMPurify(view as unknown as WindowLike)))
  return purify
}

/**
 * markdownToHtml output from a model → HTML that loads nothing from another host.
 * `doc` is where the work happens; the browser's document when absent.
 */
export function sanitizeUntrusted(html: string, doc?: Document): string {
  return withoutRemoteLoads(purifierFor(doc).sanitize(html, UNTRUSTED_CONFIG), doc)
}

/** An SVG drawn from untrusted text (a mermaid diagram), stripped the same way. */
export function sanitizeUntrustedSvg(svg: string): string {
  return withoutRemoteLoads(
    DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: REMOTE_TAGS, FORBID_ATTR: REMOTE_ATTRS }),
  )
}

const CSS_IMPORT = /@import\b[^;]*;?/gi
/** `url(…)` that is not a reference into this document (`url(#arrow)`). */
const REMOTE_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi

function withoutRemoteLoads(html: string, doc: Document = document): string {
  const tpl = doc.createElement('template')
  tpl.innerHTML = html
  const root = tpl.content
  for (const img of root.querySelectorAll('img')) {
    const src = (img.getAttribute('src') ?? '').trim()
    if (parseAttachmentPath(src) || /^data:image\//i.test(src)) continue
    const alt = img.getAttribute('alt')?.trim() ?? ''
    if (/^https?:\/\//i.test(src) && !img.closest('a')) {
      const link = doc.createElement('a')
      link.setAttribute('href', src)
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer nofollow')
      link.textContent = alt || src
      img.replaceWith(link)
    } else {
      // A member-only or protocol-relative path, or an image already inside a link: its words, if any.
      img.replaceWith(doc.createTextNode(alt))
    }
  }
  // A stylesheet (mermaid's own, which an init directive can extend) or a
  // presentation attribute can fetch through url() and @import.
  for (const style of root.querySelectorAll('style')) {
    style.textContent = (style.textContent ?? '').replace(CSS_IMPORT, '').replace(REMOTE_URL, 'none')
  }
  for (const el of root.querySelectorAll('*')) {
    for (const { name, value } of [...el.attributes]) {
      if (/url\(/i.test(value) && value.replace(REMOTE_URL, '') !== value) el.removeAttribute(name)
    }
  }
  return tpl.innerHTML
}
