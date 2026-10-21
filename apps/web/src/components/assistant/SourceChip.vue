<script setup lang="ts">
// One citation, either kind (docs/features/25), with its provenance card
// (docs/features/38).
//
// A workspace page and a web page are cited by the same answer and must not be
// told apart by reading them: one is a link into the product, the other leaves
// it, and clicking the wrong one is a navigation you have to undo. So the two
// differ on every axis a glance uses — the page carries a document icon and the
// product's own foreground, the web source carries its site's derived mark and
// says its host out loud.
//
// The card is what tells a reader how much the chip is worth: which revision
// the answer read, who wrote it, how long ago it changed, whether anyone has
// checked it, and what kind of fact it is. A chip alone says "a page"; the card
// says "a page nobody has looked at since March". Hover where hovering exists,
// tap elsewhere — the same two-surface split UserChip makes.
//
// The mark is a letter and a hue hashed from the host rather than a favicon:
// see lib/web-source for why the obvious answer is the wrong one.
//
// A third kind since #339: a window of a searchable group's chat. It is
// neither — not a page (nobody wrote it to be read later), not the web — so it
// gets its own icon and says when it was said, the one thing a reader needs to
// weigh it. It opens in the messenger where the platform has a link, and in
// chat search otherwise.
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useMediaQuery } from '@vueuse/core'
import { ExternalLink, FileText, MessagesSquare } from 'lucide-vue-next'
import type { AssistantSource } from '@knowledge/contracts'
import { assistantSourceHref, isChatSource, isPageSource, isWebSource } from '@knowledge/contracts'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import UserAvatar from '@/components/merge-requests/UserAvatar.vue'
import { displayPath, siteColor, siteInitial } from '@/lib/web-source'
import { formatDateTime, formatRelative } from '@/lib/format'
import { citeNumber, sourceHref, verificationTone } from '@/lib/citations'

const props = defineProps<{
  source: AssistantSource
  /** `chip` for the answer footer, `row` for the sources rail. */
  variant?: 'chip' | 'row'
  /** A marker in the answer naming this source is hovered or focused. */
  active?: boolean
}>()

const emit = defineEmits<{
  /** The pointer entered (true) or left (false) the chip — the answer highlights the matching markers. */
  hover: [boolean]
}>()

const { t } = useI18n()
const web = computed(() => (isWebSource(props.source) ? props.source : null))
const chat = computed(() => (isChatSource(props.source) ? props.source : null))
const page = computed(() => (isPageSource(props.source) ? props.source : null))
/** Where the chip leaves the product: the web page, or the chat message the platform links. */
const external = computed(() => web.value?.url ?? chat.value?.url ?? null)
const row = computed(() => props.variant === 'row')
const href = computed(() => (page.value ? sourceHref(page.value) : assistantSourceHref(props.source, '')))
const number = computed(() => (props.source.cite ? citeNumber(props.source.cite) : null))
const tone = computed(() => verificationTone(page.value?.verification))

/**
 * Anything at all to say beyond the title? A row persisted before provenance
 * existed has nothing, and offering an empty card is worse than offering none.
 */
const hasCard = computed(() => {
  const s = props.source
  if (isWebSource(s)) return !!(s.snippet || s.fetchedAt)
  if (isChatSource(s)) return true
  return !!(s.revisionNumber || s.authorId || s.changedAt || s.verification || s.factClass || s.headingPath?.length || s.snippet)
})

const section = computed(() => page.value?.headingPath?.join(' › ') ?? '')
const changed = computed(() => (page.value?.changedAt ? formatRelative(page.value.changedAt) : ''))
const fetched = computed(() => (web.value?.fetchedAt ? formatRelative(web.value.fetchedAt) : ''))
const said = computed(() => (chat.value ? formatRelative(chat.value.lastAt) : ''))

const open = ref(false)
const canHover = useMediaQuery('(hover: hover)')
</script>

<template>
  <component
    :is="hasCard ? (canHover ? HoverCard : Popover) : 'span'"
    v-bind="hasCard ? { open, 'onUpdate:open': (v: boolean) => (open = v), openDelay: 260, closeDelay: 120 } : {}"
  >
    <component :is="hasCard ? (canHover ? HoverCardTrigger : PopoverTrigger) : 'span'" v-bind="hasCard ? { asChild: true } : {}">
      <component
        :is="external ? 'a' : RouterLink"
        v-bind="external ? { href: external, target: '_blank', rel: 'noopener noreferrer' } : { to: href }"
        :title="hasCard ? undefined : source.snippet"
        class="kn-source group/src"
        :class="[row ? 'kn-source-row' : 'kn-source-chip', active && 'kn-source-active']"
        :data-tone="tone"
        @mouseenter="emit('hover', true)"
        @mouseleave="emit('hover', false)"
        @focus="emit('hover', true)"
        @blur="emit('hover', false)"
      >
        <!-- The number the answer cites this source by, where one exists. -->
        <span v-if="number" class="kn-cite-no" aria-hidden="true">{{ number }}</span>

        <span
          v-if="web"
          class="kn-site-mark"
          :style="{ backgroundColor: siteColor(web.site) }"
          aria-hidden="true"
          >{{ siteInitial(web.site) }}</span
        >
        <span v-else-if="chat" class="kn-source-icon">
          <MessagesSquare class="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/src:text-primary" />
        </span>
        <span v-else class="kn-source-icon">
          <FileText class="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/src:text-primary" />
          <!-- Verification as a dot, not a word: the chip is read in a row of
               six, and a word per chip would be the whole footer. -->
          <span v-if="page?.verification" class="kn-verify-dot" :title="t(`assistant.provenance.verification.${page.verification}`)" />
        </span>

        <span class="min-w-0 flex-1 truncate leading-snug">{{ source.title }}</span>

        <!-- The host is the citation's real identity, so it is shown, not implied
             by a mark. In a row it gets its own line under the title; in a chip it
             trails the title, dimmed, where it reads as an attribution. -->
        <span v-if="web" class="kn-site-host">{{ web.site }}<span v-if="row" class="kn-site-path">{{ displayPath(web.url) }}</span></span>
        <span v-else-if="chat" class="kn-site-host">{{ said }}</span>
      </component>
    </component>

    <component v-if="hasCard" :is="canHover ? HoverCardContent : PopoverContent" class="w-80 p-3 text-sm" :side-offset="8">
      <!-- Page: the receipt for one citation. -->
      <template v-if="page">
        <p class="flex items-start gap-2">
          <span v-if="number" class="kn-cite-no mt-0.5">{{ number }}</span>
          <span class="min-w-0">
            <span class="block font-medium leading-snug">{{ page.title }}</span>
            <span v-if="section" class="block truncate text-xs text-muted-foreground" :title="section">{{ section }}</span>
          </span>
        </p>

        <dl class="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <template v-if="page.revisionNumber">
            <dt class="text-muted-foreground">{{ t('assistant.provenance.revision') }}</dt>
            <dd>#{{ page.revisionNumber }}</dd>
          </template>
          <template v-if="page.authorId">
            <dt class="text-muted-foreground">{{ t('assistant.provenance.author') }}</dt>
            <dd class="flex min-w-0 items-center gap-1.5">
              <UserAvatar :user-id="page.authorId" :name="page.authorName" size="sm" />
              <span class="truncate">{{ page.authorName ?? page.authorId.slice(0, 8) }}</span>
            </dd>
          </template>
          <template v-if="changed">
            <dt class="text-muted-foreground">{{ t('assistant.provenance.changed') }}</dt>
            <dd>{{ changed }}</dd>
          </template>
        </dl>

        <div class="mt-2.5 flex flex-wrap gap-1.5">
          <span v-if="page.verification" class="kn-prov-badge" :data-tone="tone">
            <span class="kn-verify-dot" aria-hidden="true" />
            {{ t(`assistant.provenance.verification.${page.verification}`) }}
            <span v-if="page.verification === 'verified' && page.verifiedByName" class="opacity-70">· {{ page.verifiedByName }}</span>
          </span>
          <span v-if="page.factClass" class="kn-prov-badge" data-tone="none" :title="t('assistant.provenance.factTitle')">
            {{ t(`assistant.provenance.fact.${page.factClass}`) }}
          </span>
        </div>

        <p v-if="page.snippet" class="mt-2.5 line-clamp-3 text-xs text-muted-foreground">{{ page.snippet }}</p>

        <RouterLink :to="href" class="mt-2.5 inline-flex items-center gap-1 text-xs text-primary hover:underline">
          {{ t('assistant.provenance.openPage') }}
        </RouterLink>
      </template>

      <!-- Chat: which group, when, and what was said — masked, authors unnamed. -->
      <template v-else-if="chat">
        <p class="flex items-start gap-2">
          <span v-if="number" class="kn-cite-no mt-0.5">{{ number }}</span>
          <span class="min-w-0">
            <span class="block font-medium leading-snug">{{ chat.title }}</span>
            <span class="block text-xs text-muted-foreground">
              {{ t('assistant.provenance.chatSpan', { from: formatDateTime(chat.firstAt), to: formatDateTime(chat.lastAt) }) }}
            </span>
          </span>
        </p>
        <p v-if="chat.snippet" class="mt-2.5 line-clamp-4 whitespace-pre-line text-xs text-muted-foreground">{{ chat.snippet }}</p>
        <component
          :is="chat.url ? 'a' : RouterLink"
          v-bind="chat.url ? { href: chat.url, target: '_blank', rel: 'noopener noreferrer' } : { to: href }"
          class="mt-2.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <ExternalLink v-if="chat.url" class="size-3" />
          {{ t(chat.url ? 'assistant.provenance.openChat' : 'assistant.provenance.openChatSearch') }}
        </component>
      </template>

      <!-- Web: the address, and how old the reading is. -->
      <template v-else-if="web">
        <p class="font-medium leading-snug">{{ web.title }}</p>
        <a :href="web.url" target="_blank" rel="noopener noreferrer" class="mt-1 block truncate text-xs text-muted-foreground hover:underline">
          {{ web.url }}
        </a>
        <p v-if="fetched" class="mt-2 text-xs text-muted-foreground">{{ t('assistant.provenance.fetched', { when: fetched }) }}</p>
        <p v-if="web.snippet" class="mt-2 line-clamp-3 text-xs text-muted-foreground">{{ web.snippet }}</p>
        <a :href="web.url" target="_blank" rel="noopener noreferrer" class="mt-2.5 inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <ExternalLink class="size-3" />
          {{ t('assistant.provenance.openSite') }}
        </a>
      </template>
    </component>
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
.kn-source-chip:hover,
.kn-source-chip.kn-source-active {
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
.kn-source-row:hover,
.kn-source-row.kn-source-active {
  background: var(--accent);
}
.kn-source-row .kn-site-mark,
.kn-source-row .kn-source-icon {
  margin-top: 0.125rem;
}

/* The citation number: the same glyph the answer's superscripts use, so the
   eye can carry it from the sentence to the chip. */
.kn-cite-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  min-width: 1.05rem;
  height: 1.05rem;
  padding: 0 0.25rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  color: var(--muted-foreground);
}
.kn-source-active .kn-cite-no,
.kn-source-chip:hover .kn-cite-no {
  border-color: var(--primary);
  color: var(--primary);
}

.kn-source-icon {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}
.kn-source-icon .kn-verify-dot {
  position: absolute;
  right: -2px;
  bottom: -1px;
  width: 6px;
  height: 6px;
  box-shadow: 0 0 0 1.5px var(--background);
}
.kn-verify-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--muted-foreground);
  opacity: 0.6;
}
[data-tone='ok'] .kn-verify-dot {
  background: var(--color-emerald-500, #10b981);
  opacity: 1;
}
[data-tone='warn'] .kn-verify-dot {
  background: var(--color-amber-500, #f59e0b);
  opacity: 1;
}
[data-tone='bad'] .kn-verify-dot {
  background: var(--destructive);
  opacity: 1;
}

.kn-prov-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.125rem 0.5rem;
  font-size: 11px;
  color: var(--foreground);
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
