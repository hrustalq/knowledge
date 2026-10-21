<script setup lang="ts">
/**
 * Code on the API surfaces (#78): a sample, an example body, a response. It is
 * highlighted with the same `hljs-*` ramp the editor's code blocks use, so a
 * JSON body reads the same in a page and in a reference card.
 *
 * Lowlight hands back a syntax tree, and the tree is turned into vnodes here —
 * never into an HTML string — so a response body from someone else's server
 * reaches the page as text nodes and nothing else.
 *
 * A body (an example, a response) carries a `caption` strip, Postman's shape:
 * what it is on the left, **Copy JSON** on the right, always visible — it is
 * there to be pasted into a client. A sample keeps the quieter corner button.
 *
 * A body past `HIGHLIGHT_LIMIT` is shown plain: tokenising a megabyte of JSON
 * would hold the main thread for longer than the request took.
 */
import { computed, h, type VNode } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy } from 'lucide-vue-next'
import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import xml from 'highlight.js/lib/languages/xml'
import { useCopy } from '@/lib/use-copy'

export type ApiCodeLang = 'bash' | 'go' | 'javascript' | 'json' | 'python' | 'xml'

const props = withDefaults(
  defineProps<{
    code: string
    lang?: ApiCodeLang | null
    copyable?: boolean
    maxHeight?: string
    wrap?: boolean
    label?: string
    /** Set, the code sits under a strip naming it (a media type) with Copy always showing: a body someone came to paste. */
    caption?: string
  }>(),
  { lang: null, copyable: true, maxHeight: '26rem', wrap: false, label: undefined, caption: undefined },
)
const { t } = useI18n()
const { state: copyState, copy } = useCopy()

interface HastNode {
  type: string
  value?: string
  properties?: { className?: string[] }
  children?: HastNode[]
}

function render(nodes: HastNode[]): Array<VNode | string> {
  return nodes.map((n) =>
    n.type === 'text'
      ? (n.value ?? '')
      : h('span', { class: n.properties?.className?.join(' ') }, render(n.children ?? [])),
  )
}

const copyText = computed(() =>
  copyState.value === 'copied' ? t('apiSamples.copied')
  : copyState.value === 'failed' ? t('apiSamples.copyFailedShort')
  : props.lang === 'json' ? t('apiSamples.copyJson')
  : t('apiSamples.copy'),
)

const content = computed(() => {
  if (!props.lang || props.code.length > HIGHLIGHT_LIMIT) return [props.code]
  try {
    return render(lowlight.highlight(props.lang, props.code).children as HastNode[])
  } catch {
    return [props.code]
  }
})
</script>

<script lang="ts">
const HIGHLIGHT_LIMIT = 200_000
const lowlight = createLowlight({ bash, go, javascript, json, python, xml })
</script>

<template>
  <div class="kn-code group/code relative min-w-0" :data-strip="caption !== undefined || undefined">
    <div v-if="caption !== undefined" class="kn-code-strip">
      <span class="min-w-0 truncate font-mono">{{ caption }}</span>
      <button
        v-if="copyable"
        type="button"
        class="kn-code-strip-copy"
        :data-state="copyState"
        :title="copyState === 'failed' ? t('apiSamples.copyFailed') : undefined"
        @click="copy(code)"
      >
        <Check v-if="copyState === 'copied'" class="size-3.5" aria-hidden="true" />
        <Copy v-else class="size-3.5" aria-hidden="true" />
        <span aria-live="polite">{{ copyText }}</span>
      </button>
    </div>
    <pre
      tabindex="0"
      class="kn-code-pre overflow-auto border px-3.5 py-3 font-mono text-ui leading-[1.65]"
      :class="[wrap && 'whitespace-pre-wrap [overflow-wrap:anywhere]', caption !== undefined ? 'rounded-b-lg border-t-0' : 'rounded-lg']"
      :style="{ maxHeight }"
      :aria-label="label ?? caption"
    ><code><component :is="() => content" /></code></pre>
    <button
      v-if="copyable && caption === undefined"
      type="button"
      class="kn-code-copy absolute top-2 right-2 flex h-7 items-center gap-1.5 rounded-md border bg-card px-2 text-xs font-medium text-muted-foreground shadow-xs transition-[opacity,color,background-color] duration-150 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
      :data-state="copyState"
      :title="copyState === 'failed' ? t('apiSamples.copyFailed') : undefined"
      @click="copy(code)"
    >
      <Check v-if="copyState === 'copied'" class="size-3.5" />
      <Copy v-else class="size-3.5" />
      <span aria-live="polite">{{ copyText }}</span>
    </button>
  </div>
</template>

<style scoped>
.kn-code-pre {
  tab-size: 2;
  font-variant-ligatures: none;
  color: var(--foreground);
  background: color-mix(in oklab, var(--foreground) 4%, var(--card));
}
.kn-code-pre::selection,
.kn-code-pre ::selection {
  background: color-mix(in oklab, var(--primary) 28%, transparent);
}
/* The copy control waits at rest on a pointer device and is always there on touch. */
@media (hover: hover) {
  .kn-code-copy:not([data-state='copied']):not([data-state='failed']):not(:focus-visible) {
    opacity: 0;
  }
  .group\/code:hover .kn-code-copy {
    opacity: 1;
  }
}
.kn-code-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 2.25rem;
  padding: 0.2rem 0.3rem 0.2rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: 8px 8px 0 0;
  background: color-mix(in oklab, var(--foreground) 7%, var(--card));
  font-size: var(--kn-text-xs);
  color: color-mix(in oklab, var(--foreground) 70%, var(--card));
}
.kn-code-strip-copy {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.4rem;
  height: 1.75rem;
  padding-inline: 0.6rem;
  border-radius: 6px;
  font-size: var(--kn-text-ui);
  font-weight: 500;
  color: var(--foreground);
  transition: background-color 120ms ease-out, color 120ms ease-out;
}
.kn-code-strip-copy:hover {
  background: color-mix(in oklab, var(--foreground) 8%, transparent);
}
.kn-code-strip-copy:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.kn-code-strip-copy[data-state='copied'],
.kn-code-copy[data-state='copied'] {
  color: color-mix(in oklab, var(--kn-panel-tip) 70%, var(--foreground));
}
</style>
