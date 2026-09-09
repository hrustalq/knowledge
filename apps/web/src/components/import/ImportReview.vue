<script setup lang="ts">
/**
 * Read what came out, fix it, then commit it.
 *
 * This is deliberately the *same shell* as `/documents/:id/edit`: the title in
 * the editor's own lede slot, the prose column owning the scroll, a rail down
 * the side. The whole reason this refactor exists is that the import path and
 * the authoring path had drifted into two different products — so correcting a
 * heading the PDF parser guessed wrong is the same gesture here as it will be
 * on the page tomorrow, in the same component, at the same measure.
 *
 * The rail carries everything that is true of the *parse* rather than of the
 * document: where the text came from, what the parser found, and what it could
 * not carry. That last one is the important one — an import that quietly loses
 * half a document and says nothing is the failure this flow exists to prevent —
 * so the losses sit beside the text, legible while you read it, rather than in
 * a toast that has already gone.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { AlertTriangle, ChevronDown, FolderTree, ScanText } from 'lucide-vue-next'
import type { ImportJobInfo, ImportMeta } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Collapse } from '@/components/ui/collapse'
import RichEditor from '@/components/editor/RichEditor.vue'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { PARSER_ICONS, formatBytes } from './formats'

const { t } = useI18n()

const props = defineProps<{
  job: ImportJobInfo
  meta: ImportMeta
  warnings: string[]
  projectId: string
  category: string
  parentId: string
}>()

const emit = defineEmits<{ back: [] }>()

const title = defineModel<string>('title', { required: true })
const markdown = defineModel<string>('markdown', { required: true })

const editorRef = ref<InstanceType<typeof RichEditor> | null>(null)
const warningsOpen = ref(false)

const projects = useProjectsStore()
const documents = useDocumentsStore()

const ParserIcon = computed(() => (props.job.parser ? PARSER_ICONS[props.job.parser] : ScanText))

/** Only the counts this parser actually produced — no zeroed placeholders. */
const found = computed(() => {
  const m = props.meta
  const parts: string[] = []
  if (m.pages) parts.push(`${m.pages} ${m.pages === 1 ? 'page' : 'pages'}`)
  if (m.slides) parts.push(`${m.slides} ${m.slides === 1 ? 'slide' : 'slides'}`)
  if (m.sections) parts.push(`${m.sections} ${m.sections === 1 ? 'section' : 'sections'}`)
  if (m.words) parts.push(t('import.words', { n: m.words }, m.words))
  if (m.images) parts.push(`${m.images} ${m.images === 1 ? 'image' : 'images'}`)
  return parts
})

const destination = computed(() => {
  const project = projects.items.find((p) => p.projectId === props.projectId)?.name ?? 'Project'
  const parent = props.parentId
    ? documents.items.find((d) => d.documentId === props.parentId)?.title
    : null
  return [project, parent, props.category].filter(Boolean) as string[]
})

/**
 * Never submit stale text: the editor debounces, so the page flushes through
 * here before it reads the markdown.
 */
defineExpose({
  flush(): string {
    markdown.value = editorRef.value?.flush() ?? markdown.value
    return markdown.value
  },
})

const mentionablePages = computed(() =>
  documents.items.map((d) => ({ documentId: d.documentId, title: d.title, category: d.category })),
)

const empty = computed(() => markdown.value.trim().length === 0)
</script>

<template>
  <div class="kn-page-body">
    <!-- The same main column the editor page uses: RichEditor fills it, and its
         own surface is what scrolls. -->
    <div class="kn-page-main">
      <RichEditor ref="editorRef" v-model="markdown" :pages="mentionablePages">
        <template #lede>
          <textarea
            v-model="title"
            class="kn-title-input"
            rows="1"
            :placeholder="t('import.pageTitle')"
            :aria-label="t('import.pageTitle')"
            spellcheck="false"
            @keydown.enter.prevent="editorRef?.focus()"
          />
          <p v-if="empty" class="mt-2 text-sm text-muted-foreground">
            The parser found no text in this file. You can write the page yourself here, or discard
            the import and try a different one.
          </p>
        </template>
      </RichEditor>
    </div>

    <aside class="kn-import-rail">
      <!-- Provenance: what this was, and what the parser made of it. -->
      <section class="space-y-3 border-b p-4">
        <h2 class="text-sm font-semibold">{{ t('import.importedFrom') }}</h2>
        <div class="flex items-start gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-primary">
            <component :is="ParserIcon" class="size-4" aria-hidden="true" />
          </span>
          <div class="min-w-0 text-sm">
            <p class="truncate font-medium" :title="job.sourceFilename">{{ job.sourceFilename }}</p>
            <p class="text-muted-foreground">{{ formatBytes(job.sizeBytes) }}</p>
          </div>
        </div>
        <p v-if="found.length" class="text-sm text-muted-foreground">{{ found.join(' · ') }}</p>
        <p class="text-xs text-muted-foreground">{{ t('import.originalStaysAttached') }}</p>
      </section>

      <!-- What the parse could not carry. Never swallowed. -->
      <section
        v-if="warnings.length"
        class="border-b border-amber-500/25 bg-amber-500/5 p-4 text-sm dark:border-amber-400/20"
      >
        <p class="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle class="size-4 shrink-0" aria-hidden="true" />
          {{ warnings.length === 1 ? 'One thing to check' : `${warnings.length} things to check` }}
        </p>
        <ul class="mt-2 space-y-1.5 text-amber-900/90 dark:text-amber-100/80">
          <li v-for="w in warnings.slice(0, 2)" :key="w" class="flex gap-2">
            <span class="mt-2 size-1 shrink-0 rounded-full bg-current opacity-60" aria-hidden="true" />
            <span>{{ w }}</span>
          </li>
        </ul>
        <!-- The rest expand rather than appear: a list that jumps to full
             height makes you re-find the line you were reading. This is where
             that idiom was first written; it now lives in ui/collapse so every
             disclosure in the app opens the same way. -->
        <Collapse :open="warningsOpen" :unmount="false">
          <ul class="space-y-1.5 text-amber-900/90 dark:text-amber-100/80">
            <li v-for="w in warnings.slice(2)" :key="w" class="flex gap-2 pt-1.5">
              <span class="mt-2 size-1 shrink-0 rounded-full bg-current opacity-60" aria-hidden="true" />
              <span>{{ w }}</span>
            </li>
          </ul>
        </Collapse>
        <button
          v-if="warnings.length > 2"
          type="button"
          class="mt-2 flex items-center gap-1 text-xs font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-300"
          @click="warningsOpen = !warningsOpen"
        >
          {{ warningsOpen ? 'Show fewer' : `Show all ${warnings.length}` }}
          <ChevronDown class="size-3 transition-transform duration-150" :class="warningsOpen && 'rotate-180'" />
        </button>
      </section>

      <section class="space-y-3 p-4">
        <h2 class="text-sm font-semibold">{{ t('import.whereItGoes') }}</h2>
        <p class="flex items-start gap-2 text-sm text-muted-foreground">
          <FolderTree class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{{ destination.join(' › ') }}</span>
        </p>
        <Button variant="outline" size="sm" @click="emit('back')">Change destination</Button>
      </section>
    </aside>
  </div>
</template>

<style scoped>
/*
 * A wider measure than the editor page's.
 *
 * `--kn-measure` is 46rem globally, which is the right reading width for
 * *writing* a page from scratch. Reviewing an import is a different job: you
 * are checking a parse against a document you already know, scanning tables and
 * headings rather than composing sentences, and the rail already takes 24–28rem
 * of the width. At 46rem the prose sat in the middle of the column with a third
 * of it empty on either side. The property inherits, so setting it here reaches
 * `.kn-prose` inside RichEditor without touching any other surface.
 */
.kn-page-main {
  --kn-measure: 58rem;
}

/* The editor's authoring padding assumes a narrow column; with a wide measure
   the horizontal part is just extra gutter on top of the centring. */
.kn-page-main :deep(.kn-editor-content) {
  padding-inline: 2rem;
}

@media (max-width: 1023px) {
  .kn-page-body {
    flex-direction: column;
    overflow-y: auto;
  }
}

/* Matches the editor page's assistant rail and the detail page's rail scale. */
.kn-import-rail {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 24rem;
  min-height: 0;
  overflow-y: auto;
  border-left: 1px solid var(--border);
  background: var(--background);
}

@media (min-width: 1280px) {
  .kn-import-rail {
    width: 28rem;
  }
}

/*
 * Below the editor's own breakpoint a rail would leave the prose column
 * unusably narrow, so it goes under the text instead of beside it — and the
 * body stacks rather than splits.
 */
@media (max-width: 1023px) {
  .kn-import-rail {
    width: 100%;
    overflow-y: visible;
    border-top: 1px solid var(--border);
    border-left: none;
  }
}

</style>
