<script setup lang="ts">
/**
 * A shared page's body (docs/features/43). The HTML arrives finished from the
 * server (lib/markdown/public-render.server) — sanitized, links and assets
 * already rewritten into the share's scope — so it renders during SSR and the
 * client only upgrades what cannot be static: mermaid diagrams, which need a
 * browser to lay out, and images and diagrams, which open in a lightbox
 * (#467, #476).
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DOMPurify from 'dompurify'
import { KN } from '@/lib/markdown/nodes'
import { useTheme } from '@/lib/theme'
import { mermaidConfig, mermaidSvg } from '@/lib/mermaid'
import { markZoomable } from '@/lib/image-gallery'
import { markDiagrams } from '@/lib/diagram-gallery'
import ImageLightbox from '@/components/ui/lightbox/ImageLightbox.vue'
import DiagramLightbox from '@/components/ui/lightbox/DiagramLightbox.vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{ html: string }>()

const { t } = useI18n()
const host = ref<HTMLElement | null>(null)
const theme = useTheme()

async function renderMermaid() {
  const root = host.value
  if (!root) return
  const blocks = [...root.querySelectorAll<HTMLElement>(`[${KN.mermaid}]`)]
  if (blocks.length === 0) return
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize(mermaidConfig(theme.isDark.value))
  for (const block of blocks) {
    try {
      const { svg } = await mermaidSvg(mermaid, block.textContent ?? '')
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

onMounted(async () => {
  if (host.value) markZoomable(host.value, t)
  await renderMermaid()
  // Drawings came drawn from the server; mermaid figures exist only now.
  if (host.value) markDiagrams(host.value, t)
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized server-side with the app's SANITIZE_CONFIG -->
  <div ref="host" v-bind="$attrs" class="markdown-body max-w-none" v-html="props.html" />
  <ImageLightbox :root="host" />
  <DiagramLightbox :root="host" />
</template>
