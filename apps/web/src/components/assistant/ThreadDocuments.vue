<script setup lang="ts">
// The right pane: everything this thread cited, materialized from each
// message's structured `sources` — never parsed out of the chat text. Read,
// created, or drafted-as-a-merge-request all land here.
//
// It fills in mid-turn as well as after it, so the moment the assistant is
// finding things is the moment you can see what it found.
//
// Since feature 25 a citation can also be a page on the open web, and the two
// are kept apart rather than interleaved. They are different promises: a page
// is in the workspace and will still be there tomorrow, a web source was read
// once to settle this question and nothing about it was saved. Sorting them
// into one list by recency would make that difference something you have to
// notice per row.
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { isWebSource } from '@knowledge/contracts'
import { assistantSourceKey } from '@knowledge/contracts'
import { useAssistantStore } from '@/stores/assistant'
import SourceChip from './SourceChip.vue'

const { t } = useI18n()

const assistant = useAssistantStore()

const pages = computed(() => assistant.documentsTouched.filter((s) => !isWebSource(s)))
const web = computed(() => assistant.documentsTouched.filter(isWebSource))
</script>

<template>
  <aside class="flex h-full w-72 shrink-0 flex-col border-l bg-background">
    <!-- h-14 to land on the same divider line as the rail and the chat header. -->
    <header class="flex h-14 shrink-0 flex-col justify-center border-b px-4">
      <h2 class="text-sm font-semibold">{{ t('chat.sourcesTitle') }}</h2>
      <p class="truncate text-[11px] text-muted-foreground">
        {{ t('chat.sourcesHint') }}
      </p>
    </header>

    <div class="quiet-scroll min-h-0 flex-1 overflow-y-auto p-2">
      <p
        v-if="pages.length === 0 && web.length === 0"
        class="px-2 py-1 text-xs leading-relaxed text-muted-foreground"
      >
        {{ t('chat.noSourcesYet') }}
      </p>

      <template v-else>
        <!-- Group headings appear only once both groups can exist, so a thread
             that never left the workspace looks exactly as it did before. -->
        <section v-if="pages.length" class="mb-1">
          <h3 v-if="web.length" class="kn-src-heading">{{ t('chat.pagesInChat') }}</h3>
          <ul class="space-y-0.5">
            <li v-for="doc in pages" :key="assistantSourceKey(doc)">
              <SourceChip :source="doc" variant="row" />
            </li>
          </ul>
        </section>

        <section v-if="web.length">
          <h3 class="kn-src-heading">{{ t('chat.fromTheWeb') }}</h3>
          <ul class="space-y-0.5">
            <li v-for="source in web" :key="assistantSourceKey(source)">
              <SourceChip :source="source" variant="row" />
            </li>
          </ul>
          <!-- Said once, at the foot of the group it applies to. The single
               most likely wrong assumption about this pane is that reading a
               page here added it to the workspace. -->
          <p class="mt-2 px-2 text-[11px] leading-relaxed text-muted-foreground/80">
            {{ t('chat.webNotSaved') }}
          </p>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.kn-src-heading {
  padding: 0.375rem 0.5rem 0.25rem;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
</style>
