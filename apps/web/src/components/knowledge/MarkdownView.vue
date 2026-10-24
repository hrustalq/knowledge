<script setup lang="ts">
/**
 * Read-side renderer (docs/features/01). Parses with the *same* pipeline the
 * editor uses (lib/markdown/render), so a page cannot look one way when read
 * and another way when opened for editing.
 *
 * Everything the editor can produce renders here, and none of it needs a
 * component: panels, expands, layouts and status chips are pure CSS, <details>
 * is natively interactive, and the only JS upgrades are the three things that
 * genuinely cannot be static — mermaid, whiteboard scenes, and PDF frames.
 *
 * SSR renders nothing (DOMPurify needs a DOM); the client fills in on mount.
 */
import { nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DOMPurify from 'dompurify'
import { markdownToHtml, SANITIZE_CONFIG, slugifyHeading } from '@/lib/markdown/render'
import { parseScene, renderSceneToSvg } from '@/lib/markdown/drawing'
import { KN, attachmentKind, carryDiagramLayout, embedItemsOf, escapeHtml } from '@/lib/markdown/nodes'
import { embedTile } from '@/lib/embeds'
import { formatBytes } from '@/lib/format'
import { mayContainPageRef } from '@/lib/page-refs'
import { usePageRefsStore } from '@/stores/page-refs'
import { resolveAssetUrl } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import { mermaidConfig, mermaidSvg } from '@/lib/mermaid'
import { createRevealTracker, wrapRuns } from '@/lib/stream-reveal'
import { markZoomable } from '@/lib/image-gallery'
import { markDiagrams } from '@/lib/diagram-gallery'
import ImageLightbox from '@/components/ui/lightbox/ImageLightbox.vue'
import DiagramLightbox from '@/components/ui/lightbox/DiagramLightbox.vue'

// Several roots (the body and the lightboxes), so a parent's class lands on the body by hand.
defineOptions({ inheritAttrs: false })

interface MarkdownHeading { id: string; text: string; level: number }

const props = withDefaults(
  defineProps<{
    markdown: string
    /**
     * The text is still arriving. Parsing stays live (that is the whole effect),
     * but the passes that only make sense on finished text are skipped: heading
     * ids would churn on every token, and rendering a mermaid block from a fence
     * that has not closed yet just flashes an error at the reader.
     */
    streaming?: boolean
  }>(),
  { streaming: false },
)
const emit = defineEmits<{
  headings: [MarkdownHeading[]]
  /** The host element, after every pass has run — where decorations attach. */
  rendered: [root: HTMLElement]
}>()

const pageRefsStore = usePageRefsStore()
const { t } = useI18n()

const host = ref<HTMLElement | null>(null)
const html = ref('')
const theme = useTheme()

/**
 * Page references by title need the roster, and the roster costs a request —
 * so it is fetched only for text that actually contains a candidate. Most of
 * what this component renders is a comment or a chat reply with none, and those
 * must not each pull the workspace's page list.
 */
async function pageRefResolver(markdown: string) {
  if (!mayContainPageRef(markdown)) return undefined
  await pageRefsStore.ensureLoaded()
  return pageRefsStore.resolve
}

/**
 * What the reader has already seen of a streaming reply, so each render can
 * mark only the characters that are new (lib/stream-reveal). Reset when a
 * stream ends: a finished reply renders plain, and the next one starts over.
 */
const reveal = createRevealTracker()

async function render() {
  const markdown = props.markdown ?? ''
  const resolvePage = await pageRefResolver(markdown)
  html.value = DOMPurify.sanitize(markdownToHtml(markdown, { resolvePage }), { ...SANITIZE_CONFIG })
  await nextTick()
  if (props.streaming) {
    const root = host.value
    if (root) {
      wrapRuns(root, reveal.advance(root.textContent?.length ?? 0))
      // Decorations that make sense on unfinished text (citation markers,
      // docs/features/38) hang off this; the heavy passes above still wait.
      emit('rendered', root)
    }
    return
  }
  reveal.reset()
  const headings = collectHeadings()
  wrapTables()
  resolveAssets()
  renderDrawings()
  renderFiles()
  renderEmbeds()
  renderToc(headings)
  await renderMermaid()
  if (!host.value) return
  // Last, once every diagram is drawn: DiagramLightbox reads the marks as "done".
  markDiagrams(host.value, t)
  emit('rendered', host.value)
}

function collectHeadings(): MarkdownHeading[] {
  const root = host.value
  if (!root) return []
  const headings: MarkdownHeading[] = []
  const seen = new Map<string, number>()
  for (const el of root.querySelectorAll<HTMLElement>('h1, h2, h3')) {
    const text = el.textContent ?? ''
    let id = slugifyHeading(text) || 'section'
    const count = seen.get(id) ?? 0
    seen.set(id, count + 1)
    if (count > 0) id = `${id}-${count}`
    el.id = id
    headings.push({ id, text, level: Number(el.tagName[1]) })
  }
  emit('headings', headings)
  return headings
}

/**
 * A wide table has to scroll inside its own box, but the box cannot be the
 * table: `display:block` on a table makes it shrink to its content instead of
 * filling the column. Tiptap wraps tables for the same reason; this is the
 * read view's equivalent.
 *
 * Both that box and a code block scroll sideways, and a box that scrolls must
 * be reachable without a pointer: the arrow keys only move what has focus.
 */
function wrapTables() {
  const root = host.value
  if (!root) return
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('kn-table-scroll')) continue
    const wrap = document.createElement('div')
    wrap.className = 'kn-table-scroll'
    wrap.tabIndex = 0
    table.replaceWith(wrap)
    wrap.append(table)
  }
  for (const pre of root.querySelectorAll('pre:not([tabindex])')) pre.setAttribute('tabindex', '0')
}

/**
 * Attachment links are stored as bare `/v1/...` paths so the markdown stays
 * portable. The environment prefix and the credential are added here, at
 * render time — `<img>` cannot send an Authorization header.
 */
function resolveAssets() {
  const root = host.value
  if (!root) return
  for (const img of root.querySelectorAll<HTMLImageElement>('img[src^="/v1/"]')) {
    // The selector guarantees a `/v1/…` src, so read it straight: an `?? ''`
    // fallback here was unreachable, and an empty src is exactly the bug it
    // looked like it was guarding against.
    img.src = resolveAssetUrl(img.getAttribute('src')!)
  }
  // Every image, not only attachments: an external one below the fold is no
  // more urgent than ours.
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    img.loading = 'lazy'
    img.decoding = 'async'
  }
  // Only finished text gets here, so a reply still streaming has nothing to open.
  markZoomable(root, t)
}

function renderDrawings() {
  const root = host.value
  if (!root) return
  for (const node of root.querySelectorAll<HTMLElement>(`[${KN.drawing}]`)) {
    const scene = parseScene(node.textContent ?? '')
    const wrap = document.createElement('div')
    wrap.className = 'kn-drawing-canvas'
    // Built from our own scene model, not from page content, so this is not
    // an injection surface — but it is sanitized anyway, as SVG.
    wrap.innerHTML = DOMPurify.sanitize(renderSceneToSvg(scene), {
      USE_PROFILES: { svg: true, svgFilters: true },
    })
    carryDiagramLayout(node, wrap)
    node.replaceWith(wrap)
  }
}

function renderFiles() {
  const root = host.value
  if (!root) return
  for (const node of root.querySelectorAll<HTMLElement>(`[${KN.file}]`)) {
    const name = node.getAttribute('data-kn-name') ?? 'attachment'
    const mime = node.getAttribute('data-kn-mime') ?? ''
    const size = Number(node.getAttribute('data-kn-size')) || 0
    const rawHref = node.querySelector('a')?.getAttribute('href') ?? ''
    const href = resolveAssetUrl(rawHref)
    const download = `${href}${href.includes('?') ? '&' : '?'}download=1`
    const kind = attachmentKind(mime)

    const card = document.createElement('div')
    card.className = 'kn-block kn-file'
    card.dataset.kind = kind
    card.innerHTML = `
      <div class="kn-file-head">
        <span class="kn-file-glyph" aria-hidden="true">${kind === 'pdf' ? 'PDF' : 'FILE'}</span>
        <span class="kn-file-name">${escapeHtml(name)}</span>
        ${size ? `<span class="kn-file-size">${formatBytes(size)}</span>` : ''}
        <span class="kn-file-links">
          <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open</a>
          <a href="${escapeHtml(download)}" download="${escapeHtml(name)}">Download</a>
        </span>
      </div>
      ${
        kind === 'pdf'
          ? `<object class="kn-file-pdf" data="${escapeHtml(href)}" type="application/pdf" aria-label="Preview of ${escapeHtml(name)}"><div class="kn-file-fallback">This browser cannot display PDFs inline. <a href="${escapeHtml(download)}" download="${escapeHtml(name)}">Download ${escapeHtml(name)}</a></div></object>`
          : ''
      }`
    node.replaceWith(card)
  }
}

/** Embed groups (#470) as the editor draws them: captioned link tiles, built from the items, never the raw markup. */
function renderEmbeds() {
  const root = host.value
  if (!root) return
  for (const figure of root.querySelectorAll<HTMLElement>(`figure[${KN.embed}]`)) {
    const list = document.createElement('div')
    list.className = 'kn-embed-items'
    for (const item of embedItemsOf(figure)) {
      const tile = embedTile(item, t('editor.embed.wholeFile'))
      const el = document.createElement(tile.href ? 'a' : 'span')
      el.className = 'kn-embed-item'
      if (tile.href) {
        el.setAttribute('href', tile.href)
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer nofollow')
      }
      el.innerHTML = `<span class="kn-embed-caption">${escapeHtml(tile.caption || t('editor.embed.untitled'))}</span><span class="kn-embed-meta">${escapeHtml(tile.meta)}</span>`
      list.append(el)
    }
    figure.classList.add('kn-embed')
    figure.querySelectorAll(':scope > :not(figcaption)').forEach((el) => el.remove())
    figure.querySelector('figcaption')?.classList.add('kn-embed-figcaption')
    figure.prepend(list)
  }
}

function renderToc(headings: MarkdownHeading[]) {
  const root = host.value
  if (!root) return
  for (const node of root.querySelectorAll<HTMLElement>(`[${KN.toc}]`)) {
    const list = document.createElement('nav')
    list.className = 'kn-block kn-toc'
    list.setAttribute('aria-label', 'On this page')
    list.innerHTML = `<div class="kn-toc-head">On this page</div>${
      headings.length
        ? `<ol class="kn-toc-list">${headings
            .map((h) => `<li data-level="${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
            .join('')}</ol>`
        : '<p class="kn-toc-empty">This page has no headings yet.</p>'
    }`
    node.replaceWith(list)
  }
}

async function renderMermaid() {
  const root = host.value
  if (!root) return
  const blocks = [...root.querySelectorAll<HTMLElement>(`[${KN.mermaid}]`)]
  if (blocks.length === 0) return
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize(mermaidConfig(theme.isDark.value))
  for (const block of blocks) {
    const source = block.textContent ?? ''
    try {
      const { svg } = await mermaidSvg(mermaid, source)
      const wrap = document.createElement('div')
      wrap.className = 'kn-mermaid-figure'
      wrap.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
      carryDiagramLayout(block, wrap)
      block.replaceWith(wrap)
    } catch {
      // Leave the source visible and flagged rather than swallowing the block:
      // a diagram that fails to parse is still content the author wrote.
      block.classList.add('kn-mermaid-broken')
    }
  }
}

onMounted(render)
// `streaming` is watched too: when a turn finishes the same text needs one
// more pass to pick up headings and diagrams that were deferred. Theme is
// watched because mermaid bakes its colors into the SVG it emits.
watch([() => props.markdown, () => props.streaming, theme.isDark], () => void render())
</script>

<template>
  <div
    ref="host"
    v-bind="$attrs"
    class="markdown-body max-w-none"
    :class="streaming ? 'is-streaming' : ''"
    v-html="html"
  />
  <ImageLightbox :root="host" />
  <DiagramLightbox :root="host" />
</template>
