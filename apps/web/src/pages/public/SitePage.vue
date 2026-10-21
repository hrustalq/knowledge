<script setup lang="ts">
/**
 * A published site's reader (docs/features/44, issue #77 phase 2a).
 *
 * The root of the public app (public-main.ts) for a site, as SharePage is for
 * a share: no router, no stores, no auth. Every page is a full server render
 * of the version's snapshot, so navigation is plain links — the nav, the
 * version switcher and prev/next all work with JavaScript off, which is also
 * what a crawler sees. The client only upgrades mermaid and the theme toggle,
 * and adds search (SiteSearch), which has no server-rendered form.
 *
 * The nav is the app rail's tree (TreeRow, issue #204): the server sends the
 * top level and the open path to the current page, the way docs sites do — a
 * 500-page tree drawn whole is a list nobody reads — and expanding any other
 * branch loads that one level (site-tree). The layout is the app shell's: the
 * rail pinned to the left edge, the content filling the rest, and below `lg`
 * the same rail as a drawer that opens from `#site-nav` with JavaScript off.
 *
 * A site with pages that are not public (issue #77 phase 3) offers sign-in, a
 * plain link through the app; whoever is signed in can sign out, which needs
 * JavaScript (it is a POST) and then reloads into the anonymous view.
 *
 * A site that answers questions offers Ask (SiteAsk, the same panel the
 * embeddable widget shows) in a sheet beside search. It asks as this reader,
 * so a signed-in reader's answers may draw on pages others cannot see.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, LogIn, LogOut, Menu, MessageCircleQuestion, Moon, Sun, X } from 'lucide-vue-next'
import type { PublicSiteTreeNode, PublicSiteTreeResponse } from '@knowledge/contracts'
import { formatDate } from '@/lib/format'
import { toggleTheme } from '@/lib/theme'
import { TreeWindowKey, treeDepthBudget, treeShift } from '@/lib/tree-window'
import PublicMarkdown from '@/components/public/PublicMarkdown.vue'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import SiteAsk from './SiteAsk.vue'
import SiteSearch from './SiteSearch.vue'
import SiteTreeNode from './SiteTreeNode.vue'
import { publicSiteSessionPath, publicSiteTreePath } from '@knowledge/contracts/publishing'
import { siteHomeId, siteHref, type PublicReaderState } from './reader-state'
import { createSiteTree, SiteTreeKey } from './site-tree'

const props = defineProps<{ state: PublicReaderState }>()

const { t } = useI18n()

const view = computed(() => (props.state.view.kind === 'site' ? props.state.view : null))
const site = computed(() => view.value?.site ?? null)
const page = computed(() => view.value?.page ?? null)
const homeId = computed(() => (site.value ? siteHomeId(site.value.tree) : null))

const href = (documentId: string, slugPath: string) =>
  site.value ? siteHref(site.value, site.value.version, slugPath, documentId === homeId.value) : '#'
const hrefOf = (node: PublicSiteTreeNode) => href(node.documentId, node.slugPath)
const homeHref = computed(() => (site.value ? siteHref(site.value, site.value.version, '', true) : '/'))

const prev = computed(() => page.value?.prev ?? null)
const next = computed(() => page.value?.next ?? null)

/** One level of the nav, as this reader sees it: the cookie travels, so a signed-in reader gets their pages. */
async function loadLevel(parentId: string): Promise<PublicSiteTreeNode[]> {
  const s = site.value!
  const params = new URLSearchParams({ parent: parentId })
  if (!s.version.isDefault) params.set('version', s.version.slug)
  const res = await fetch(`${props.state.apiBase}${publicSiteTreePath(s.id)}?${params}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(String(res.status))
  return ((await res.json()) as PublicSiteTreeResponse).nodes
}

const tree = createSiteTree({
  initial: site.value?.tree ?? [],
  activeId: page.value?.documentId ?? null,
  load: loadLevel,
})
provide(SiteTreeKey, tree)
const topLevel = computed(() => tree.children.get(null) ?? [])

/** The rail's horizontal window (lib/tree-window), as in the app; the rail is a fixed 16rem here. */
const RAIL_PX = 256
const focusDepth = ref(tree.activeDepth)
provide(TreeWindowKey, {
  reveal: (depth) => (focusDepth.value = depth),
  retreat: (depth) => (focusDepth.value = Math.min(focusDepth.value, depth)),
})
const shift = computed(() => treeShift(focusDepth.value, treeDepthBudget(RAIL_PX)))

/**
 * The current page can sit a hundred rows down an open branch. The rail is
 * scrolled to it (the rail, not the page) so it answers "where am I" on
 * arrival rather than after a hunt.
 */
const railScroll = ref<HTMLElement | null>(null)
onMounted(() => {
  const el = railScroll.value
  const active = el?.querySelector<HTMLElement>('[aria-current="page"]')
  if (!el || !active) return
  const offset = active.getBoundingClientRect().top - el.getBoundingClientRect().top
  if (offset > el.clientHeight - 48) el.scrollTop += offset - el.clientHeight / 3
})

/**
 * The drawer below `lg`. With JavaScript it is state, so the URL keeps no
 * `#site-nav`; without, the same links open it through `:target` (style.css).
 */
const navOpen = ref(false)
const navClose = ref<HTMLAnchorElement | null>(null)
const navToggle = ref<HTMLAnchorElement | null>(null)
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeNav()
}
watch(navOpen, async (open) => {
  if (open) {
    window.addEventListener('keydown', onKeydown)
    await nextTick()
    navClose.value?.focus()
  } else {
    window.removeEventListener('keydown', onKeydown)
  }
})
function closeNav() {
  if (!navOpen.value) return
  navOpen.value = false
  navToggle.value?.focus()
}
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const toc = computed(() => page.value?.headings.filter((h) => h.level > 1) ?? [])
const date = (iso: string) => formatDate(iso, props.state.locale)

/**
 * A version switch keeps the reader on the same page: straight to it when the
 * server knows where it lives there, else through `?from=`, which lands on
 * the target version's home when it does not have the page.
 */
function versionHref(target: { slug: string; name: string; isDefault: boolean }): string {
  if (!site.value) return '#'
  const alternate = page.value?.alternates.find((a) => a.versionSlug === target.slug)
  if (alternate) return alternate.href
  const isHome = !page.value || page.value.documentId === homeId.value
  const base = siteHref(site.value, target, page.value?.slugPath ?? '', isHome)
  return page.value && !isHome ? `${base}?from=${page.value.documentId}` : base
}
const currentVersion = computed(() => site.value?.versions.find((v) => v.isDefault) ?? null)

const signedIn = computed(() => !!site.value && site.value.viewer !== 'anonymous')
const askOpen = ref(false)
const askPanel = ref<InstanceType<typeof SiteAsk> | null>(null)
const signingOut = ref(false)
const signOutFailed = ref(false)

async function signOut() {
  if (!site.value || signingOut.value) return
  signingOut.value = true
  signOutFailed.value = false
  try {
    const res = await fetch(`${props.state.apiBase}${publicSiteSessionPath(site.value.id)}/end`, {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(String(res.status))
    window.location.reload()
  } catch {
    signOutFailed.value = true
    signingOut.value = false
  }
}
</script>

<template>
  <div class="kn-site min-h-dvh bg-background text-foreground">
    <main v-if="!site" class="mx-auto mt-24 max-w-md space-y-2 px-6 text-center">
      <h1 class="text-lg font-semibold">{{ t('siteReader.siteNotFoundTitle') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('siteReader.siteNotFoundBody') }}</p>
    </main>

    <template v-else>
      <header class="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div class="flex h-14 items-center gap-3 px-4">
          <a
            v-if="topLevel.length"
            ref="navToggle"
            href="#site-nav"
            class="-ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            :aria-label="t('siteReader.pages')"
            aria-controls="site-nav"
            :aria-expanded="navOpen"
            @click.prevent="navOpen = !navOpen"
          >
            <Menu class="size-4" aria-hidden="true" />
          </a>
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

          <SiteSearch v-if="site.tree.length" :site="site" :api-base="state.apiBase" />
          <button
            v-if="site.ask && site.tree.length"
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-haspopup="dialog"
            @click="askOpen = true"
          >
            <MessageCircleQuestion class="size-4" aria-hidden="true" />
            <span class="sr-only sm:not-sr-only">{{ t('siteReader.ask') }}</span>
          </button>

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

          <a
            v-if="!signedIn && site.signInUrl"
            :href="site.signInUrl"
            class="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          ><LogIn class="size-4" aria-hidden="true" />{{ t('siteReader.signIn') }}</a>
          <button
            v-else-if="signedIn"
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            :title="site.viewer === 'member' ? t('siteReader.signedInMember') : t('siteReader.signedInVisitor')"
            :disabled="signingOut"
            @click="signOut"
          ><LogOut class="size-4" aria-hidden="true" />{{ t('siteReader.signOut') }}</button>

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

      <Sheet v-if="site.ask" v-model:open="askOpen">
        <SheetContent side="right" class="w-full gap-0 p-0 sm:max-w-lg" @open-auto-focus.prevent="askPanel?.focus()">
          <SheetHeader class="border-b px-4 py-3 pr-12">
            <SheetTitle class="text-base">{{ t('siteReader.askTitle', { site: site.title }) }}</SheetTitle>
            <SheetDescription class="sr-only">{{ t('siteReader.askDescription') }}</SheetDescription>
          </SheetHeader>
          <SiteAsk
            ref="askPanel"
            class="min-h-0 flex-1"
            :site-id="site.id"
            :site-title="site.title"
            :api-base="state.apiBase"
            :version-slug="site.version.isDefault ? null : site.version.slug"
          />
        </SheetContent>
      </Sheet>

      <p v-if="signOutFailed" role="alert" class="border-b bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">
        {{ t('siteReader.signOutFailed') }}
      </p>

      <p
        v-if="!site.version.isDefault && currentVersion"
        class="kn-callout-warning border-b px-4 py-2 text-center text-sm"
      >
        {{ t('siteReader.outdatedVersion', { name: site.version.name }) }}
        <a :href="versionHref(currentVersion)" class="font-medium underline">{{ t('siteReader.toCurrent') }}</a>
      </p>

      <div class="flex">
        <!-- The rail: pinned to the left edge from `lg`, a drawer below it. -->
        <nav
          v-if="topLevel.length"
          id="site-nav"
          class="kn-site-rail flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:w-64 lg:shrink-0"
          :data-open="navOpen"
          :aria-label="t('siteReader.pages')"
        >
          <div class="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border px-4 lg:hidden">
            <span class="truncate text-sm font-semibold">{{ site.title }}</span>
            <a
              ref="navClose"
              href="#"
              class="-mr-1 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
              :aria-label="t('siteReader.closePages')"
              @click.prevent="closeNav"
            ><X class="size-4" aria-hidden="true" /></a>
          </div>
          <div
            ref="railScroll"
            class="quiet-scroll kn-tree-window min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-4"
            :style="{ '--kn-tree-shift': `${shift}px` }"
            :data-windowed="shift > 0"
          >
            <ul class="space-y-px">
              <SiteTreeNode v-for="node in topLevel" :key="node.documentId" :node="node" :depth="0" :href="hrefOf" />
            </ul>
          </div>
          <!-- The header's links only fit the header from `md`; below it the
               drawer is the one place a phone reader can reach them. -->
          <ul
            v-if="site.theme.headerLinks.length"
            class="shrink-0 space-y-px border-t border-sidebar-border px-2 py-3 md:hidden"
          >
            <li v-for="link in site.theme.headerLinks" :key="link.url">
              <a
                :href="link.url"
                rel="noopener noreferrer"
                target="_blank"
                class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <span class="min-w-0 truncate">{{ link.label }}</span>
                <ExternalLink class="size-3 shrink-0" aria-hidden="true" />
              </a>
            </li>
          </ul>
        </nav>
        <!-- Without JavaScript the scrim is a link back out of `:target`. -->
        <a
          v-if="topLevel.length"
          href="#"
          class="kn-site-scrim"
          tabindex="-1"
          aria-hidden="true"
          @click.prevent="closeNav"
        />

        <div class="flex min-w-0 flex-1 flex-col">
          <!-- The landmark a reader (and a screen reader's "skip to main") lands
               on; the header, rail and footer sit outside it. -->
          <main class="flex flex-1 gap-8 px-4 py-6 lg:px-8 lg:py-8">
            <article class="min-w-0 flex-1">
              <!-- The column fills, as every in-app page does; the prose keeps
                   its own reading measure (--kn-text-measure in editor.css), so
                   tables and code fences beside it get the whole width. -->
              <div>
                <template v-if="page">
                  <h1 class="mb-1 text-3xl font-semibold tracking-tight text-balance">{{ page.title }}</h1>
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
                  <p v-else-if="!site.signInUrl || signedIn" class="text-sm text-muted-foreground">{{ t('siteReader.emptySite') }}</p>
                  <!-- Said on any miss of a site with restricted pages: it names no page, so it confirms none. -->
                  <p v-if="site.signInUrl && !signedIn" class="text-sm text-muted-foreground">
                    {{ t('siteReader.restrictedHint') }}
                    <a :href="site.signInUrl" class="font-medium text-primary hover:underline">{{ t('siteReader.signIn') }}</a>
                  </p>
                </div>
              </div>
            </article>

            <aside v-if="toc.length > 1" class="hidden w-52 shrink-0 xl:block" :aria-label="t('siteReader.onThisPage')">
              <div class="sticky top-24">
                <p class="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{{ t('siteReader.onThisPage') }}</p>
                <ul class="space-y-1 text-sm">
                  <li v-for="h in toc" :key="h.id" :style="{ paddingLeft: `${(h.level - 2) * 0.75}rem` }">
                    <a :href="`#${h.id}`" class="text-muted-foreground hover:text-foreground">{{ h.text }}</a>
                  </li>
                </ul>
              </div>
            </aside>
          </main>

          <footer v-if="site.theme.footerText" class="border-t">
            <p class="kn-measure px-4 py-6 text-sm whitespace-pre-line text-muted-foreground lg:px-8">
              {{ site.theme.footerText }}
            </p>
          </footer>
        </div>
      </div>
    </template>
  </div>
</template>
