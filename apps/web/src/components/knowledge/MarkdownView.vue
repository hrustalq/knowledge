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
import DOMPurify from 'dompurify'
import { markdownToHtml, SANITIZE_CONFIG } from '@/lib/markdown/render'
import { parseScene, renderSceneToSvg } from '@/lib/markdown/drawing'
import { KN, attachmentKind, escapeHtml, formatBytes } from '@/lib/markdown/nodes'
import { resolveAssetUrl } from '@/lib/api'
import { useTheme } from '@/lib/theme'

interface MarkdownHeading { id: string; text: string; level: number }

const props = defineProps<{
  markdown: string
  /**
   * The text is still arriving. Parsing stays live (that is the whole effect),
   * but the passes that only make sense on finished text are skipped: heading
   * ids would churn on every token, and rendering a mermaid block from a fence
   * that has not closed yet just flashes an error at the reader.
   */
  streaming?: boolean
}>()
const emit = defineEmits<{ headings: [MarkdownHeading[]] }>()

const host = ref<HTMLElement | null>(null)
const html = ref('')
const theme = useTheme()

let mermaidSeq = 0

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80)
}

async function render() {
  html.value = DOMPurify.sanitize(markdownToHtml(props.markdown ?? ''), { ...SANITIZE_CONFIG })
  await nextTick()
  if (props.streaming) return
  const headings = collectHeadings()
  wrapTables()
  resolveAssets()
  renderDrawings()
  renderFiles()
  renderToc(headings)
  await renderMermaid()
}

function collectHeadings(): MarkdownHeading[] {
  const root = host.value
  if (!root) return []
  const headings: MarkdownHeading[] = []
  const seen = new Map<string, number>()
  for (const el of root.querySelectorAll<HTMLElement>('h1, h2, h3')) {
    const text = el.textContent ?? ''
    let id = slugify(text) || 'section'
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
 */
function wrapTables() {
  const root = host.value
  if (!root) return
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('kn-table-scroll')) continue
    const wrap = document.createElement('div')
    wrap.className = 'kn-table-scroll'
    table.replaceWith(wrap)
    wrap.append(table)
  }
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
    img.src = resolveAssetUrl(img.getAttribute('src') ?? '')
    img.loading = 'lazy'
    img.decoding = 'async'
  }
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
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme.isDark.value ? 'dark' : 'default',
    fontFamily: 'inherit',
  })
  for (const block of blocks) {
    const source = block.textContent ?? ''
    try {
      const { svg } = await mermaid.render(`mmd-${Date.now()}-${mermaidSeq++}`, source)
      const wrap = document.createElement('div')
      wrap.className = 'kn-mermaid-figure'
      wrap.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
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
  <div ref="host" class="markdown-body max-w-none" :class="streaming ? 'is-streaming' : ''" v-html="html" />
</template>
