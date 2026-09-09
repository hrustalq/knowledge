<script setup lang="ts">
/**
 * Docs shell: the same three-pane shape as the projects settings page — a
 * roster rail flush against the settings nav, the article beside it in pane 3,
 * so moving between articles replaces only the article and the rail you picked
 * from stays put.
 *
 * The search here is deliberately **only over the documentation**. The product's
 * own search answers about a workspace's content; this one answers "which page
 * of the manual explains this", which is a different question with a different
 * corpus, and folding them together would make both worse.
 *
 * No virtualization, unlike the projects roster: this list is authored, so its
 * length is known and small. A virtualizer here would be machinery guarding
 * against a case that cannot occur.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { Search, Sparkles, X } from 'lucide-vue-next'
import { articles, sections, searchArticles, type DocArticle } from '@/pages/docs/registry'
import { Input } from '@/components/ui/input'

const { t } = useI18n()
const route = useRoute()

const query = ref('')

const matches = computed(() => searchArticles(query.value))
const searching = computed(() => query.value.trim().length > 0)

/** The skill page hangs off the foot of the rail, not in the section list. */
const SKILL_SLUG = 'agent-skill'
const skill = articles.find((a) => a.slug === SKILL_SLUG)

/** Sections minus the skill page, which has its own home below. */
const grouped = computed(() =>
  sections
    .map((section) => ({ ...section, articles: section.articles.filter((a) => a.slug !== SKILL_SLUG) }))
    .filter((section) => section.articles.length > 0),
)

function isCurrent(article: DocArticle): boolean {
  const slug = route.params.slug as string | undefined
  // No slug is the overview: the first article is what the child renders.
  return slug ? slug === article.slug : article === articles[0]
}
</script>

<template>
  <!-- Bleed out the settings column's padding so the rail sits flush against
       the settings nav, exactly as the projects roster does. -->
  <div class="-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 lg:flex-row">
    <div
      class="flex h-80 shrink-0 flex-col border-b bg-background lg:sticky lg:top-0 lg:h-[calc(100vh-5.75rem)] lg:w-64 lg:self-start lg:border-b-0 lg:border-r"
    >
      <div class="border-b p-2">
        <div class="relative">
          <Search class="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            v-model="query"
            :placeholder="t('docs.searchPlaceholder')"
            :aria-label="t('docs.searchLabel')"
            class="h-8 pr-7 pl-8 text-sm"
          />
          <button
            v-if="searching"
            type="button"
            class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            :aria-label="t('common.clear')"
            @click="query = ''"
          >
            <X class="size-3.5" />
          </button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <!-- Search results: flat and ranked, with the sections that matched as
             jump targets. Keeping the section grouping here would bury the
             ranking under headers that mostly hold one row. -->
        <template v-if="searching">
          <p v-if="matches.length === 0" class="p-3 text-xs text-muted-foreground">
            {{ t('docs.noMatches', { query: query.trim() }) }}
          </p>
          <ul v-else class="py-1">
            <li v-for="match in matches" :key="match.article.slug">
              <RouterLink
                :to="`/settings/docs/${match.article.slug}`"
                class="block px-3 py-2 text-sm transition-colors"
                :class="
                  isCurrent(match.article)
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-foreground/80 hover:bg-accent hover:text-foreground'
                "
              >
                <span class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate">{{ match.article.title }}</span>
                  <span class="shrink-0 text-[11px] text-muted-foreground">{{ match.count }}</span>
                </span>
                <span v-if="match.excerpt" class="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
                  {{ match.excerpt }}
                </span>
              </RouterLink>
              <ul v-if="match.headings.length" class="pb-1">
                <li v-for="heading in match.headings" :key="heading.id">
                  <RouterLink
                    :to="`/settings/docs/${match.article.slug}#${heading.id}`"
                    class="block truncate border-l py-1 pr-3 pl-6 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground"
                  >
                    {{ heading.text }}
                  </RouterLink>
                </li>
              </ul>
            </li>
          </ul>
        </template>

        <template v-else>
          <div v-for="section in grouped" :key="section.name" class="py-1">
            <p class="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {{ section.name }}
            </p>
            <ul>
              <li v-for="article in section.articles" :key="article.slug">
                <RouterLink
                  :to="`/settings/docs/${article.slug}`"
                  class="block truncate px-3 py-1.5 text-sm transition-colors"
                  :class="
                    isCurrent(article)
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-foreground/80 hover:bg-accent hover:text-foreground'
                  "
                >
                  {{ article.title }}
                </RouterLink>
              </li>
            </ul>
          </div>
        </template>
      </div>

      <!-- Where the projects rail puts Create, this puts the hand-off. -->
      <div v-if="skill" class="mt-auto shrink-0 border-t p-2">
        <RouterLink
          :to="`/settings/docs/${skill.slug}`"
          class="flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors"
          :class="
            isCurrent(skill)
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-foreground/80 hover:bg-accent hover:text-foreground'
          "
        >
          <Sparkles class="size-4 shrink-0" />
          <span class="min-w-0 truncate">{{ skill.title }}</span>
        </RouterLink>
      </div>
    </div>

    <div data-kn-pane="3" class="flex min-h-0 min-w-0 flex-1 flex-col px-4 py-6 lg:px-8">
      <RouterView />
    </div>
  </div>
</template>
