<script setup lang="ts">
/**
 * A shared page's body (docs/features/43). The HTML arrives finished from the
 * server (lib/markdown/public-render.server) — sanitized, links and assets
 * already rewritten into the share's scope — so it renders during SSR and the
 * client only upgrades what cannot be static: mermaid diagrams, which need a
 * browser to lay out.
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DOMPurify from 'dompurify'
import { KN } from '@/lib/markdown/nodes'
import { useTheme } from '@/lib/theme'

const props = defineProps<{ html: string }>()

const { t } = useI18n()
const host = ref<HTMLElement | null>(null)
const theme = useTheme()

let seq = 0

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
    try {
      const { svg } = await mermaid.render(`pub-mmd-${seq++}`, block.textContent ?? '')
      const wrap = document.createElement('div')
      wrap.className = 'kn-mermaid-figure'
      wrap.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
      block.replaceWith(wrap)
    } catch {
      block.classList.add('kn-mermaid-broken')
      block.title = t('shareReader.diagramFailed')
    }
  }
}

onMounted(() => void renderMermaid())
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized server-side with the app's SANITIZE_CONFIG -->
  <div ref="host" class="markdown-body max-w-none" v-html="props.html" />
</template>
