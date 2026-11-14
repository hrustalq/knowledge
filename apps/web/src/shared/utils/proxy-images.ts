import { imageSrc } from '@/shared/api/api'

/**
 * Sanitized HTML whose images the member app's CSP lets load (#1133): every
 * `<img src>` through `imageSrc` (remote ones via the image proxy), and every
 * `srcset` dropped, since its candidates would load from the other host — the
 * `src` beside it stays. Rewritten on a `<template>`, whose content belongs to
 * an inert document, so nothing loads from the original URL first.
 */
export function proxyImages(html: string): string {
  if (!/<img|srcset/i.test(html)) return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  for (const el of tpl.content.querySelectorAll('[srcset]')) el.removeAttribute('srcset')
  for (const img of tpl.content.querySelectorAll('img[src]')) img.setAttribute('src', imageSrc(img.getAttribute('src')!))
  return tpl.innerHTML
}
