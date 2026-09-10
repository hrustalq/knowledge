<script setup lang="ts">
/**
 * The definition behind a linked glossary term (docs/features/14).
 *
 * A panel rather than the browser's `title`: a definition is markdown — it has
 * emphasis, code spans, sometimes a list — and a native tooltip flattens all of
 * it into one grey line that cannot be selected, cannot be clicked through to
 * the defining page, and appears on the browser's schedule rather than the
 * reader's.
 *
 * It takes a resolved term rather than an id and fetches nothing. The roster is
 * already in the pinia store for the linking pass to have happened at all, so
 * there is nothing left to load — unlike `UserCard`, whose profile query is the
 * reason it is `open`-gated.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import type { GlossaryTerm } from '@knowledge/contracts'
import MarkdownView from './MarkdownView.vue'
import { glossaryHref } from '@/lib/glossary'

const props = defineProps<{
  term: GlossaryTerm
  /** Whether this reader may say "not a term here" (editor on the page). */
  canExclude?: boolean
}>()
const emit = defineEmits<{ exclude: [] }>()

const { t } = useI18n()

const href = computed(() => glossaryHref(props.term))
/**
 * The canonical term, not the spelling that was matched. Someone who hovered
 * «Заказ» is being told the entry is called "Заказ (Order)" — which is the
 * useful half of the answer, and what they would search for.
 */
const heading = computed(() => props.term.term)
</script>

<template>
  <div class="space-y-2">
    <p class="text-sm font-semibold text-foreground">{{ heading }}</p>
    <!--
      `glossary` is not a prop on MarkdownView any more, so a definition cannot
      link its own vocabulary and recurse — which is the behaviour this needs,
      arrived at by deletion rather than by a flag.
    -->
    <MarkdownView :markdown="term.definition" class="text-sm text-muted-foreground" />
    <div class="flex items-center justify-between gap-3 pt-0.5">
      <RouterLink
        :to="href"
        class="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {{ term.documentId ? t('glossary.openPage') : t('glossary.openEntry') }}
        <ArrowRight class="size-3" />
      </RouterLink>
      <!--
        The escape hatch per-term rules cannot express: this word is the term
        everywhere on the page except in this one sentence. Nothing is written
        to the page — the exclusion is a row, like the link itself is a
        decoration.
      -->
      <button
        v-if="canExclude"
        type="button"
        class="text-xs text-muted-foreground hover:text-foreground hover:underline"
        @click="emit('exclude')"
      >
        {{ t('glossary.notATermHere') }}
      </button>
    </div>
  </div>
</template>
