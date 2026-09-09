<script setup lang="ts">
/**
 * One documentation article.
 *
 * Rendered through the same MarkdownView every page in the product uses, so the
 * documentation cannot look unlike the thing it documents — and so panels,
 * tables, mermaid diagrams and code fences all behave here exactly as they do
 * in a page a user wrote.
 *
 * A `widget:` in the article's frontmatter appends a generated block below the
 * prose: the endpoint table, the MCP tool list, or the agent hand-off. The prose
 * around them stays editable markdown; only the tables are generated.
 */
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { Check, Copy, X } from 'lucide-vue-next'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import ApiReferenceTable from '@/components/docs/ApiReferenceTable.vue'
import McpToolTable from '@/components/docs/McpToolTable.vue'
import SkillPanel from '@/components/docs/SkillPanel.vue'
import { articles, findArticle } from '@/pages/docs/registry'
import { articleMarkdown } from '@/pages/docs/bundle'
import { Button } from '@/components/ui/button'
import { useCopy } from '@/lib/use-copy'

interface Heading {
  id: string
  text: string
  level: number
}

const { t } = useI18n()
const route = useRoute()
const { state: copyState, copy } = useCopy()

const article = computed(() => findArticle(route.params.slug as string | undefined))
const headings = ref<Heading[]>([])

/** Reading order, for the previous/next pair at the foot. */
const neighbours = computed(() => {
  const index = articles.findIndex((a) => a.slug === article.value?.slug)
  return { previous: index > 0 ? articles[index - 1] : null, next: articles[index + 1] ?? null }
})

/**
 * MarkdownView renders on mount rather than during SSR, so by the time the
 * anchor exists the browser has long since given up on the hash it was handed.
 * Scrolling is therefore driven by the render, not by navigation.
 */
function onRendered() {
  const hash = route.hash.slice(1)
  if (!hash) return
  void nextTick(() => document.getElementById(hash)?.scrollIntoView({ block: 'start' }))
}

// A different article is a different document: drop the old headings rather
// than letting the previous article's outline sit beside the new one until it
// renders.
watch(
  () => article.value?.slug,
  () => {
    headings.value = []
  },
)
</script>

<template>
  <article v-if="article" class="flex min-w-0 flex-1 gap-8">
    <div class="min-w-0 flex-1">
      <header class="mb-6 border-b pb-4">
        <p class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{{ article.section }}</p>
        <div class="mt-1 flex flex-wrap items-start gap-3">
          <h1 class="font-display min-w-0 flex-1 text-2xl font-bold tracking-tight">{{ article.title }}</h1>
          <Button variant="outline" size="sm" class="gap-1.5" @click="copy(articleMarkdown(article))">
            <Check v-if="copyState === 'copied'" class="size-3.5" />
            <X v-else-if="copyState === 'failed'" class="size-3.5" />
            <Copy v-else class="size-3.5" />
            {{ copyState === 'copied' ? t('docs.copied') : copyState === 'failed' ? t('docs.copyFailed') : t('docs.copyPage') }}
          </Button>
        </div>
        <p v-if="article.summary" class="mt-2 text-sm text-muted-foreground">{{ article.summary }}</p>
        <p v-if="article.route" class="mt-2 font-mono text-xs text-muted-foreground">{{ article.route }}</p>
      </header>

      <MarkdownView
        :key="article.slug"
        :markdown="article.body"
        class="kn-docs-prose"
        @headings="headings = $event"
        @rendered="onRendered"
      />

      <ApiReferenceTable v-if="article.widget === 'api-reference'" />
      <McpToolTable v-else-if="article.widget === 'mcp-tools'" />
      <SkillPanel v-else-if="article.widget === 'agent-skill'" />

      <nav v-if="neighbours.previous || neighbours.next" class="mt-10 flex gap-3 border-t pt-4">
        <RouterLink
          v-if="neighbours.previous"
          :to="`/settings/docs/${neighbours.previous.slug}`"
          class="min-w-0 flex-1 rounded-md border p-3 transition-colors hover:bg-accent"
        >
          <span class="block text-[11px] text-muted-foreground">{{ t('docs.previous') }}</span>
          <span class="block truncate text-sm font-medium">{{ neighbours.previous.title }}</span>
        </RouterLink>
        <RouterLink
          v-if="neighbours.next"
          :to="`/settings/docs/${neighbours.next.slug}`"
          class="min-w-0 flex-1 rounded-md border p-3 text-right transition-colors hover:bg-accent"
        >
          <span class="block text-[11px] text-muted-foreground">{{ t('docs.next') }}</span>
          <span class="block truncate text-sm font-medium">{{ neighbours.next.title }}</span>
        </RouterLink>
      </nav>
    </div>

    <!-- Outline: a fourth column only where there is room for one. -->
    <aside
      v-if="headings.length > 2"
      class="sticky top-6 hidden h-fit w-48 shrink-0 xl:block"
      :aria-label="t('docs.onThisPage')"
    >
      <p class="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {{ t('docs.onThisPage') }}
      </p>
      <ul class="space-y-1 border-l">
        <li v-for="heading in headings.filter((h) => h.level > 1)" :key="heading.id">
          <a
            :href="`#${heading.id}`"
            class="-ml-px block border-l border-transparent py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
            :class="heading.level === 3 ? 'pl-5' : 'pl-3'"
          >
            {{ heading.text }}
          </a>
        </li>
      </ul>
    </aside>
  </article>

  <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
    <p class="font-medium">{{ t('docs.notFound') }}</p>
    <p class="max-w-sm text-sm text-muted-foreground">{{ t('docs.notFoundHint') }}</p>
    <Button as-child variant="outline" size="sm">
      <RouterLink to="/settings/docs">{{ t('docs.backToStart') }}</RouterLink>
    </Button>
  </div>
</template>

<style scoped>
/*
 * The read surface caps its measure: a documentation page is read start to
 * finish, and full-width prose on a wide monitor is unreadable in a way a
 * dashboard is not. Tables and code fences opt out via their own scroll boxes.
 */
.kn-docs-prose {
  max-width: 72ch;
}
</style>
