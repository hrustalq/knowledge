<script setup lang="ts">
// One citation, either kind (docs/features/25).
//
// A workspace page and a web page are cited by the same answer and must not be
// told apart by reading them: one is a link into the product, the other leaves
// it, and clicking the wrong one is a navigation you have to undo. So the two
// differ on every axis a glance uses — the page carries a document icon and the
// product's own foreground, the web source carries its site's derived mark and
// says its host out loud.
//
// The mark is a letter and a hue hashed from the host rather than a favicon:
// see lib/web-source for why the obvious answer is the wrong one.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { FileText } from 'lucide-vue-next'
import type { AssistantSource } from '@knowledge/contracts'
import { isWebSource } from '@knowledge/contracts'
import { displayPath, siteColor, siteInitial } from '@/lib/web-source'

const props = defineProps<{
  source: AssistantSource
  /** `chip` for the answer footer, `row` for the sources rail. */
  variant?: 'chip' | 'row'
}>()

const web = computed(() => (isWebSource(props.source) ? props.source : null))
const row = computed(() => props.variant === 'row')

/**
 * The tooltip carries the full address, because the chip cannot: a citation
 * whose host is `github.com` is not yet a citation of anything.
 */
const title = computed(() => {
  const s = props.source
  return isWebSource(s) ? [s.url, s.snippet].filter(Boolean).join('\n\n') : s.snippet
})
</script>

<template>
  <component
    :is="web ? 'a' : RouterLink"
    v-bind="
      web
        ? { href: web.url, target: '_blank', rel: 'noopener noreferrer' }
        : { to: `/documents/${(source as { documentId: string }).documentId}` }
    "
    :title="title"
    class="kn-source group/src"
    :class="row ? 'kn-source-row' : 'kn-source-chip'"
  >
    <span
      v-if="web"
      class="kn-site-mark"
      :style="{ backgroundColor: siteColor(web.site) }"
      aria-hidden="true"
      >{{ siteInitial(web.site) }}</span
    >
    <FileText v-else class="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/src:text-primary" />

    <span class="min-w-0 flex-1 truncate leading-snug">{{ source.title }}</span>

    <!-- The host is the citation's real identity, so it is shown, not implied
         by a mark. In a row it gets its own line under the title; in a chip it
         trails the title, dimmed, where it reads as an attribution. -->
    <span v-if="web" class="kn-site-host">{{ web.site }}<span v-if="row" class="kn-site-path">{{ displayPath(web.url) }}</span></span>
  </component>
</template>

<style scoped>
.kn-source {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  transition: color 120ms ease-out, background-color 120ms ease-out, border-color 120ms ease-out;
}

/* Footer chip: sits in a row of them under an answer. */
.kn-source-chip {
  max-width: 18rem;
  gap: 0.375rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.125rem 0.5rem;
  font-size: 11px;
  color: var(--muted-foreground);
}
.kn-source-chip:hover {
  border-color: var(--primary);
  background: color-mix(in oklab, var(--primary) 5%, transparent);
  color: var(--primary);
}

/* Rail row: two lines, full bleed, matching the roster rows beside it. */
.kn-source-row {
  align-items: flex-start;
  border-radius: 0.375rem;
  padding: 0.375rem 0.5rem;
  font-size: 0.875rem;
  flex-wrap: wrap;
}
.kn-source-row:hover {
  background: var(--accent);
}
.kn-source-row .kn-site-mark,
.kn-source-row > svg {
  margin-top: 0.125rem;
}

/* The derived mark. Square with a soft radius, so it is never mistaken for the
   round avatar of a person — the two appear in the same transcript. */
.kn-site-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 0.1875rem;
  color: #fff;
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
}
.kn-source-row .kn-site-mark {
  width: 1.125rem;
  height: 1.125rem;
  font-size: 10px;
}

.kn-site-host {
  flex-shrink: 0;
  color: var(--muted-foreground);
  font-size: 11px;
}
.kn-source-chip .kn-site-host {
  /* Dimmed against the title it attributes, and it never wins the truncation
     fight: a host that fits and a title that does not is the wrong trade. */
  opacity: 0.75;
}
.kn-source-row .kn-site-host {
  flex-basis: 100%;
  min-width: 0;
  margin-left: 1.625rem;
  font-size: 11px;
  /* One line. A wrapped URL in a 18rem rail turns every web citation into a
     three-line block and the titles stop being the thing you read. */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.kn-site-path {
  opacity: 0.65;
}
</style>
