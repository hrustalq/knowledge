/**
 * Images a reader can open full-screen (#467), shared by the three read
 * surfaces so none of them grows its own idea of which images count.
 *
 * A surface marks its images with `ZOOM_ATTR` once they are in the DOM; the
 * lightbox listens on the surface's root and collects the marked ones in
 * document order. An image inside a link is never marked: it follows the link.
 */
export const ZOOM_ATTR = 'data-kn-zoom'

export interface GalleryImage {
  src: string
  alt: string
}

type Translate = (key: string, named?: Record<string, unknown>) => string

/** The screen-reader name of an image that opens the lightbox. */
export function zoomLabel(t: Translate, name: string): string {
  return name ? t('imageViewer.openNamed', { name }) : t('imageViewer.open')
}

/** Mark every image under `root` that is not inside a link. */
export function markZoomable(root: Element, t: Translate) {
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    if (img.closest('a')) continue
    img.setAttribute(ZOOM_ATTR, '')
    img.tabIndex = 0
    img.setAttribute('role', 'button')
    img.setAttribute('aria-label', zoomLabel(t, img.alt || img.title))
  }
}

/** The marked image an event landed on, if any. */
export function zoomableAt(target: EventTarget | null): HTMLImageElement | null {
  return target instanceof HTMLImageElement && target.hasAttribute(ZOOM_ATTR) ? target : null
}

/** Every marked image under `root`, in document order, and where `img` sits among them. */
export function galleryFrom(root: Element, img: HTMLImageElement): { images: GalleryImage[]; index: number } {
  const marked = [...root.querySelectorAll<HTMLImageElement>(`img[${ZOOM_ATTR}]`)]
  return {
    // currentSrc is what the page already loaded, so the preview is a cache hit.
    images: marked.map((el) => ({ src: el.currentSrc || el.src, alt: el.alt || el.title })),
    index: Math.max(0, marked.indexOf(img)),
  }
}
