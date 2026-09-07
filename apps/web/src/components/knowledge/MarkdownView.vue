<script setup lang="ts">
// Feature 01 (docs/features/01): client-side markdown rendering with
// sanitization and lazy mermaid diagrams. SSR renders nothing (DOMPurify
// needs a DOM); the client fills in on mount. Headings get stable slug ids
// and are emitted so pages can render an "On this page" rail.
import { nextTick, onMounted, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

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
  const raw = await marked.parse(props.markdown ?? '', { gfm: true, async: true })
  html.value = DOMPurify.sanitize(raw)
  await nextTick()
  if (props.streaming) return
  collectHeadings()
  await renderMermaid()
}

function collectHeadings() {
  const root = host.value
  if (!root) return
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
}

async function renderMermaid() {
  const root = host.value
  if (!root) return
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')]
  if (blocks.length === 0) return
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
  for (const code of blocks) {
    const pre = code.parentElement
    if (!pre) continue
    try {
      const { svg } = await mermaid.render(`mmd-${Date.now()}-${mermaidSeq++}`, code.textContent ?? '')
      const wrap = document.createElement('div')
      wrap.className = 'my-4 flex justify-center overflow-x-auto'
      wrap.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
      pre.replaceWith(wrap)
    } catch {
      pre.classList.add('border', 'border-destructive') // leave source visible on bad diagrams
    }
  }
}

onMounted(render)
// `streaming` is watched too: when a turn finishes the same text needs one
// more pass to pick up headings and diagrams that were deferred.
watch([() => props.markdown, () => props.streaming], () => void render())
</script>

<template>
  <div ref="host" class="markdown-body max-w-none" :class="streaming ? 'is-streaming' : ''" v-html="html" />
</template>

<style>
.markdown-body { line-height: 1.7; font-size: 0.95rem; }
/*
 * Streaming caret: a block that sits on the text baseline at the end of
 * whatever block is currently last, so it travels with the writing instead of
 * parking in a fixed corner. Kept out of the flow width (margin-left on an
 * inline-block) so it cannot push a line to wrap and then unwrap.
 */
.markdown-body.is-streaming > :last-child::after {
  content: "";
  display: inline-block;
  width: 0.45em;
  height: 1em;
  margin-left: 0.12em;
  vertical-align: text-bottom;
  border-radius: 1px;
  background: var(--primary);
  animation: md-caret 1s steps(2, jump-none) infinite;
}
@keyframes md-caret { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }
@media (prefers-reduced-motion: reduce) {
  .markdown-body.is-streaming > :last-child::after { animation: none; opacity: 0.6; }
}
.markdown-body :is(h1, h2, h3, h4) { scroll-margin-top: 6.5rem; }
.markdown-body h1 { font-size: 1.6rem; font-weight: 700; letter-spacing: -0.01em; margin: 1.4em 0 0.6em; }
.markdown-body h2 { font-size: 1.3rem; font-weight: 600; margin: 1.4em 0 0.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
.markdown-body h3 { font-size: 1.1rem; font-weight: 600; margin: 1.1em 0 0.4em; }
.markdown-body p { margin: 0.6em 0; }
.markdown-body ul { list-style: disc; padding-left: 1.5em; margin: 0.6em 0; }
.markdown-body ol { list-style: decimal; padding-left: 1.5em; margin: 0.6em 0; }
.markdown-body li { margin: 0.25em 0; }
.markdown-body code { background: color-mix(in srgb, currentColor 8%, transparent); border-radius: 4px; padding: 0.1em 0.35em; font-size: 0.85em; }
.markdown-body pre { background: color-mix(in srgb, currentColor 6%, transparent); border-radius: 8px; padding: 0.9em 1em; overflow-x: auto; margin: 0.8em 0; }
.markdown-body pre code { background: none; padding: 0; }
.markdown-body blockquote { border-left: 3px solid color-mix(in srgb, var(--primary) 50%, transparent); padding-left: 1em; margin: 0.8em 0; opacity: 0.85; }
.markdown-body table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
.markdown-body th, .markdown-body td { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: 0.4em 0.7em; text-align: left; }
.markdown-body th { background: color-mix(in srgb, currentColor 6%, transparent); font-weight: 600; }
.markdown-body a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.markdown-body img { max-width: 100%; border-radius: 8px; }
.markdown-body hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
</style>
