<script setup lang="ts">
/**
 * A published site's reader (docs/features/44, issue #77 phase 2a).
 *
 * The root of the public app (public-main.ts) for a site, as SharePage is for
 * a share: no router, no stores, no auth. Every page is a full server render
 * of the version's snapshot, so navigation is plain links — the nav, the
 * version switcher and prev/next all work with JavaScript off, which is also
 * what a crawler sees. The client only upgrades mermaid and the theme toggle.
 *
 * The nav shows the top level and the open path to the current page, the way
 * docs sites do: a 500-page tree drawn whole is a list nobody reads.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Menu, Moon, Sun } from 'lucide-vue-next'
import { formatDate } from '@/lib/format'
import { toggleTheme } from '@/lib/theme'
import PublicMarkdown from '@/components/public/PublicMarkdown.vue'
import { siteHomeId, siteHref, treeRows, type PublicReaderState } from './reader-state'

const props = defineProps<{ state: PublicReaderState }>()

const { t } = useI18n()

const view = computed(() => (props.state.view.kind === 'site' ? props.state.view : null))
const site = computed(() => view.value?.site ?? null)
const page = computed(() => view.value?.page ?? null)
const homeId = computed(() => (site.value ? siteHomeId(site.value.tree) : null))

/** Every page in reading order. */
const allRows = computed(() => (site.value ? treeRows(site.value.tree) : []))

/** The current page and its ancestors: the open path through the tree. */
const openPath = computed(() => {
  const open = new Set<string>()
  if (!site.value || !page.value) return open
  const parentOf = new Map(site.value.tree.map((n) => [n.documentId, n.parentId]))
  for (let id: string | null | undefined = page.value.documentId; id; id = parentOf.get(id)) open.add(id)
  return open
})

/** Top level, plus the children of every page on the open path. */
const navRows = computed(() =>
  allRows.value.filter((row) => row.parentId === null || openPath.value.has(row.parentId)),
)
const hasChildren = computed(() => new Set(site.value?.tree.map((n) => n.parentId).filter(Boolean) as string[]))

const href = (documentId: string, slugPath: string) =>
  site.value ? siteHref(site.value, site.value.version, slugPath, documentId === homeId.value) : '#'
const homeHref = computed(() => (site.value ? siteHref(site.value, site.value.version, '', true) : '/'))

const index = computed(() => allRows.value.findIndex((r) => r.documentId === page.value?.documentId))
const prev = computed(() => (index.value > 0 ? allRows.value[index.value - 1] : null))
const next = computed(() => (index.value >= 0 && index.value < allRows.value.length - 1 ? allRows.value[index.value + 1] : null))

const toc = computed(() => page.value?.headings.filter((h) => h.level > 1) ?? [])
const date = (iso: string) => formatDate(iso, props.state.locale)

/** A version switch keeps the reader on the same page when the target version has it (`?from=`). */
function versionHref(target: { slug: string; name: string; isDefault: boolean }): string {
  if (!site.value) return '#'
  const isHome = !page.value || page.value.documentId === homeId.value
  const base = siteHref(site.value, target, page.value?.slugPath ?? '', isHome)
  return page.value && !isHome ? `${base}?from=${page.value.documentId}` : base
}
const currentVersion = computed(() => site.value?.versions.find((v) => v.isDefault) ?? null)
</script>

<template>
  <div class="kn-site min-h-dvh bg-background text-foreground">
    <main v-if="!site" class="mx-auto mt-24 max-w-md space-y-2 px-6 text-center">
      <h1 class="text-lg font-semibold">{{ t('siteReader.siteNotFoundTitle') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('siteReader.siteNotFoundBody') }}</p>
    </main>

    <template v-else>
      <header class="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
        <div class="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <a :href="homeHref" class="flex min-w-0 items-center gap-2.5 font-semibold">
            <img
              v-if="site.logo?.kind === 'image'"
              :src="site.logo.url"
              alt=""
              class="size-7 shrink-0 rounded-md object-cover"
            >
            <span
              v-else-if="site.logo?.kind === 'emoji'"
              class="flex size-7 shrink-0 items-center justify-center rounded-md text-base"
              :style="site.logo.color ? { backgroundColor: site.logo.color } : undefined"
              aria-hidden="true"
            >{{ site.logo.emoji }}</span>
            <span class="truncate">{{ site.title }}</span>
          </a>

          <details v-if="site.versions.length > 1" class="relative">
            <summary
              class="flex cursor-pointer list-none items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted [&::-webkit-details-marker]:hidden"
              :aria-label="t('siteReader.versionLabel', { name: site.version.name })"
            >
              {{ site.version.name }}
              <ChevronDown class="size-3" aria-hidden="true" />
            </summary>
            <ul class="absolute left-0 z-30 mt-1 min-w-40 rounded-md border bg-popover p-1 text-sm shadow-md">
              <li v-for="v in site.versions" :key="v.slug">
                <a
                  :href="versionHref(v)"
                  class="block rounded px-2 py-1.5 hover:bg-muted"
                  :class="v.slug === site.version.slug ? 'font-medium text-primary' : ''"
                  :aria-current="v.slug === site.version.slug ? 'true' : undefined"
                >{{ v.name }}</a>
              </li>
            </ul>
          </details>

          <span class="flex-1" />

          <nav v-if="site.theme.headerLinks.length" class="hidden items-center gap-4 text-sm md:flex">
            <a
              v-for="link in site.theme.headerLinks"
              :key="link.url"
              :href="link.url"
              rel="noopener noreferrer"
              target="_blank"
              class="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >{{ link.label }}<ExternalLink class="size-3" aria-hidden="true" /></a>
          </nav>

          <button
            type="button"
            class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            :aria-label="t('siteReader.toggleTheme')"
            :title="t('siteReader.toggleTheme')"
            @click="toggleTheme"
          >
            <!-- CSS picks the icon: the server cannot know the reader's theme. -->
            <Moon class="size-4 dark:hidden" />
            <Sun class="hidden size-4 dark:block" />
          </button>
        </div>
      </header>

      <p
        v-if="!site.version.isDefault && currentVersion"
        class="border-b bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-900 dark:text-amber-200"
      >
        {{ t('siteReader.outdatedVersion', { name: site.version.name }) }}
        <a :href="versionHref(currentVersion)" class="font-medium underline">{{ t('siteReader.toCurrent') }}</a>
      </p>

      <div class="mx-auto flex max-w-7xl gap-8 px-4 py-8 sm:px-6">
        <nav v-if="navRows.length" class="hidden w-64 shrink-0 lg:block" :aria-label="t('siteReader.pages')">
          <div class="sticky top-22 max-h-[calc(100dvh-7rem)] overflow-y-auto pr-1">
            <ul class="space-y-px text-sm">
              <li v-for="row in navRows" :key="row.documentId">
                <a
                  :href="href(row.documentId, row.slugPath)"
                  class="flex items-center gap-1 rounded-md py-1 pr-2 hover:bg-muted"
                  :class="row.documentId === page?.documentId ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/80'"
                  :style="{ paddingLeft: `${0.5 + row.depth * 0.875}rem` }"
                  :aria-current="row.documentId === page?.documentId ? 'page' : undefined"
                >
                  <span class="min-w-0 flex-1 truncate">{{ row.title }}</span>
                  <ChevronRight
                    v-if="hasChildren.has(row.documentId) && !openPath.has(row.documentId)"
                    class="size-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </a>
              </li>
            </ul>
          </div>
        </nav>

        <article class="min-w-0 flex-1">
          <div class="mx-auto max-w-3xl">
            <!-- The same nav for screens too narrow for the side column. -->
            <details v-if="navRows.length" class="mb-6 rounded-md border px-3 py-2 text-sm lg:hidden">
              <summary class="flex cursor-pointer items-center gap-2 font-medium">
                <Menu class="size-4" aria-hidden="true" />{{ t('siteReader.pages') }}
              </summary>
              <ul class="mt-2 space-y-1">
                <li v-for="row in navRows" :key="row.documentId" :style="{ paddingLeft: `${row.depth * 0.875}rem` }">
                  <a
                    :href="href(row.documentId, row.slugPath)"
                    class="hover:underline"
                    :class="row.documentId === page?.documentId ? 'font-medium text-primary' : ''"
                  >{{ row.title }}</a>
                </li>
              </ul>
            </details>

            <template v-if="page">
              <h1 class="mb-1 text-3xl font-semibold tracking-tight">{{ page.title }}</h1>
              <p v-if="page.updatedAt" class="mb-8 text-xs text-muted-foreground">
                {{ t('siteReader.updated', { date: date(page.updatedAt) }) }}
              </p>
              <PublicMarkdown :html="page.html" />

              <nav v-if="prev || next" class="mt-12 grid gap-3 border-t pt-6 sm:grid-cols-2" :aria-label="t('siteReader.pages')">
                <a
                  v-if="prev"
                  :href="href(prev.documentId, prev.slugPath)"
                  class="group rounded-md border px-4 py-3 hover:border-primary"
                >
                  <span class="flex items-center gap-1 text-xs text-muted-foreground">
                    <ChevronLeft class="size-3" aria-hidden="true" />{{ t('siteReader.previous') }}
                  </span>
                  <span class="mt-0.5 block truncate font-medium group-hover:text-primary">{{ prev.title }}</span>
                </a>
                <span v-else />
                <a
                  v-if="next"
                  :href="href(next.documentId, next.slugPath)"
                  class="group rounded-md border px-4 py-3 text-right hover:border-primary"
                >
                  <span class="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                    {{ t('siteReader.next') }}<ChevronRight class="size-3" aria-hidden="true" />
                  </span>
                  <span class="mt-0.5 block truncate font-medium group-hover:text-primary">{{ next.title }}</span>
                </a>
              </nav>
            </template>

            <div v-else class="mt-16 space-y-3 text-center">
              <template v-if="site.tree.length">
                <h1 class="text-xl font-semibold">{{ t('siteReader.pageNotFoundTitle') }}</h1>
                <p class="text-sm text-muted-foreground">{{ t('siteReader.pageNotFoundBody') }}</p>
                <a :href="homeHref" class="inline-block text-sm font-medium text-primary hover:underline">{{ t('siteReader.backHome') }}</a>
              </template>
              <p v-else class="text-sm text-muted-foreground">{{ t('siteReader.emptySite') }}</p>
            </div>
          </div>
        </article>

        <aside v-if="toc.length > 1" class="hidden w-52 shrink-0 xl:block" :aria-label="t('siteReader.onThisPage')">
          <div class="sticky top-22">
            <p class="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{{ t('siteReader.onThisPage') }}</p>
            <ul class="space-y-1 text-sm">
              <li v-for="h in toc" :key="h.id" :style="{ paddingLeft: `${(h.level - 2) * 0.75}rem` }">
                <a :href="`#${h.id}`" class="text-muted-foreground hover:text-foreground">{{ h.text }}</a>
              </li>
            </ul>
          </div>
        </aside>
      </div>

      <footer v-if="site.theme.footerText" class="border-t">
        <p class="mx-auto max-w-7xl px-4 py-6 text-sm whitespace-pre-line text-muted-foreground sm:px-6">
          {{ site.theme.footerText }}
        </p>
      </footer>
    </template>
  </div>
</template>
