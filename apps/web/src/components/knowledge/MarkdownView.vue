<script setup lang="ts">
// Feature 01 (docs/features/01): client-side markdown rendering with
// sanitization and lazy mermaid diagrams. SSR renders nothing (DOMPurify
// needs a DOM); the client fills in on mount.
import { nextTick, onMounted, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{ markdown: string }>()
const host = ref<HTMLElement | null>(null)
const html = ref('')

let mermaidSeq = 0

async function render() {
  const raw = await marked.parse(props.markdown ?? '', { gfm: true, async: true })
  html.value = DOMPurify.sanitize(raw)
  await nextTick()
  await renderMermaid()
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
watch(() => props.markdown, () => void render())
</script>

<template>
  <div ref="host" class="markdown-body max-w-none" v-html="html" />
</template>

<style>
.markdown-body { line-height: 1.65; font-size: 0.95rem; }
.markdown-body h1 { font-size: 1.6rem; font-weight: 600; margin: 1.4em 0 0.6em; }
.markdown-body h2 { font-size: 1.3rem; font-weight: 600; margin: 1.3em 0 0.5em; border-bottom: 1px solid hsl(var(--border, 0 0% 90%)); padding-bottom: 0.2em; }
.markdown-body h3 { font-size: 1.1rem; font-weight: 600; margin: 1.1em 0 0.4em; }
.markdown-body p { margin: 0.6em 0; }
.markdown-body ul { list-style: disc; padding-left: 1.5em; margin: 0.6em 0; }
.markdown-body ol { list-style: decimal; padding-left: 1.5em; margin: 0.6em 0; }
.markdown-body li { margin: 0.25em 0; }
.markdown-body code { background: color-mix(in srgb, currentColor 8%, transparent); border-radius: 4px; padding: 0.1em 0.35em; font-size: 0.85em; }
.markdown-body pre { background: color-mix(in srgb, currentColor 6%, transparent); border-radius: 8px; padding: 0.9em 1em; overflow-x: auto; margin: 0.8em 0; }
.markdown-body pre code { background: none; padding: 0; }
.markdown-body blockquote { border-left: 3px solid color-mix(in srgb, currentColor 25%, transparent); padding-left: 1em; margin: 0.8em 0; opacity: 0.85; }
.markdown-body table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
.markdown-body th, .markdown-body td { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: 0.4em 0.7em; text-align: left; }
.markdown-body th { background: color-mix(in srgb, currentColor 6%, transparent); font-weight: 600; }
.markdown-body a { color: hsl(221 83% 53%); text-decoration: underline; text-underline-offset: 2px; }
.markdown-body img { max-width: 100%; border-radius: 8px; }
.markdown-body hr { border: none; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); margin: 1.5em 0; }
</style>
