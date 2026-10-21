<script setup lang="ts">
/**
 * AI settings (docs/features/12, issue #182): connecting your own agents and
 * running the workspace's assistant, under one settings row.
 *
 * Same shell-plus-child shape as /settings/docs and /settings/templates — the
 * section rail sits flush against the settings nav and the section renders in
 * pane 3, so moving between sections replaces only the pane and the rail you
 * picked from stays put.
 *
 * It used to be nine tabs in a horizontal strip that already overflowed, and
 * Connect AI was a separate settings row: "connect an agent" and "configure the
 * assistant" lived in two places. A vertical rail has room for ten sections and
 * says, by its grouping, which one is yours and which are the workspace's.
 *
 * Below `lg` the rail becomes one scrolled row, as the settings nav above it
 * does — a stacked list of ten rows would put the section a screen down.
 */
import { nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { AI_SECTION_GROUPS, type AiSectionKey } from '@/lib/ai-sections'

const { t } = useI18n()
const route = useRoute()

function isCurrent(key: AiSectionKey): boolean {
  return route.path === `/settings/ai/${key}`
}

// In the phone strip, Logs is two swipes off-screen: centre whichever row is
// current, so the strip says where you are. A no-op at `lg`, where the column
// does not scroll sideways.
const strip = ref<HTMLElement | null>(null)
async function revealCurrent() {
  await nextTick()
  const el = strip.value
  const link = el?.querySelector<HTMLElement>('[aria-current="page"]')
  if (!el || !link || el.scrollWidth <= el.clientWidth) return
  el.scrollLeft = link.offsetLeft - (el.clientWidth - link.offsetWidth) / 2
}
onMounted(revealCurrent)
watch(() => route.path, revealCurrent)
</script>

<template>
  <!-- Bleed out of the settings column's padding so the rail sits flush against
       the settings nav, as /settings/docs does. -->
  <div class="-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 lg:flex-row">
    <nav
      :aria-label="t('common.ai')"
      class="flex shrink-0 flex-col border-b bg-background lg:sticky lg:top-0 lg:h-[calc(100vh-var(--kn-chrome-h,5.75rem))] lg:w-60 lg:self-start lg:border-r lg:border-b-0"
    >
      <!-- Where docs and templates put their search, this names the area. -->
      <div class="hidden border-b px-3 py-3 lg:block">
        <p class="font-display text-base font-semibold tracking-tight">{{ t('common.ai') }}</p>
        <p class="mt-0.5 text-caption leading-snug text-muted-foreground">{{ t('ai.pageSubtitle') }}</p>
      </div>

      <div ref="strip" class="relative flex min-h-0 flex-1 gap-1 overflow-x-auto px-2 py-2 max-lg:kn-scroll-strip lg:block lg:overflow-x-visible lg:overflow-y-auto lg:p-0">
        <div
          v-for="group in AI_SECTION_GROUPS"
          :key="group.label"
          class="kn-ai-group flex shrink-0 gap-1 lg:block lg:py-1"
        >
          <p
            :id="`kn-ai-${group.label}`"
            class="hidden px-3 pt-2 pb-1 text-caption font-semibold tracking-wide text-muted-foreground uppercase lg:block"
          >
            {{ t(group.label) }}
          </p>
          <ul class="flex gap-1 lg:block" :aria-labelledby="`kn-ai-${group.label}`">
            <li v-for="section in group.sections" :key="section.key">
              <RouterLink
                :to="`/settings/ai/${section.key}`"
                class="block truncate rounded-md px-3 py-1.5 text-sm transition-colors lg:rounded-none"
                :class="
                  isCurrent(section.key)
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-foreground/80 hover:bg-accent hover:text-foreground'
                "
              >
                {{ t(section.label) }}
              </RouterLink>
            </li>
          </ul>
        </div>
      </div>
    </nav>

    <div data-kn-pane="3" class="flex min-h-0 min-w-0 flex-1 flex-col px-4 py-6 lg:px-8">
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
/* In the strip, a rule between groups stands in for the headers it hides. */
@media (width < 64rem) {
  .kn-ai-group + .kn-ai-group {
    border-left: 1px solid var(--border);
    padding-left: 0.25rem;
  }
}
</style>
