<script setup lang="ts">
/**
 * The page this item would write, before it writes it (docs/features/26).
 *
 * Deliberately the *same shell* as `ImportReview` — the title in the editor's
 * own lede slot, the prose column owning the scroll, a rail down the side — for
 * the reason given there: correcting a heading a converter guessed wrong should
 * be the same gesture here as it will be on the page tomorrow. A connector pull
 * is an import that happens repeatedly; it should not be a second product.
 *
 * The rail carries what is true of the *conversion* rather than of the
 * document: where it came from, how deep in the external tree it sits, what the
 * conversion could not carry, and the two AI assists. The losses sit beside the
 * text while you read it rather than in a toast that has already gone.
 *
 * A `conflict` item opens on the diff rather than the editor. Both sides moved,
 * so the first question is not "is this prose right" but "what am I about to
 * overwrite" — and an editor cannot ask that. The editor is one click away, and
 * it is what the merge assist writes into.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertTriangle,
  ChevronDown,
  CloudDownload,
  ExternalLink,
  FileText,
  GitMerge,
  Loader2,
  Sparkles,
  Wand2,
} from 'lucide-vue-next'
import type { CompareResponse, ConnectorRunItemInfo } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Collapse } from '@/components/ui/collapse'
import DiffView from '@/components/knowledge/DiffView.vue'
import RichEditor from '@/components/editor/RichEditor.vue'
import { useDocumentsStore } from '@/stores/documents'
import { lineDiff } from '@/lib/line-diff'
import { ACTION_CLASS, ACTION_ICON, ACTION_LABEL, ITEM_STATUS_LABEL } from './connector-ui'

const props = defineProps<{
  item: ConnectorRunItemInfo
  /** The unedited conversion, when the staged copy has diverged from it. */
  incoming: string | null
  /** The page's current content, for an `update` or `conflict` item. */
  localHead: string | null
  canManage: boolean
  /** Which AI op is running, so the pair of buttons can say which. */
  aiBusy: 'cleanup' | 'merge' | null
}>()

const emit = defineEmits<{ ai: ['cleanup' | 'merge']; fetch: [] }>()

const title = defineModel<string>('title', { required: true })
const markdown = defineModel<string>('markdown', { required: true })

const { t } = useI18n()
const documents = useDocumentsStore()

const editorRef = ref<InstanceType<typeof RichEditor> | null>(null)
const warningsOpen = ref(false)

/**
 * The two states that have no staged copy at all, and so have nothing for the
 * editor to show.
 *
 * `discovered` is the walk having found this page without reading it — which is
 * the normal state of most of the tree while a run is discovering, and of all of
 * it on a paused walk. `unchanged` is the two sides already agreeing, so nothing
 * was ever staged; on a second sync that is nearly every row. Both used to land
 * on an empty editor captioned "the conversion produced no text", which is false
 * in the first case and misleading in the second.
 */
const notFetched = computed(() => props.item.status === 'discovered')
const agreed = computed(() => props.item.status === 'unchanged')

const isConflict = computed(() => props.item.action === 'conflict')
/** Only a conflict has a second side worth reading first. */
const view = ref<'editor' | 'diff'>(isConflict.value ? 'diff' : 'editor')
watch(
  () => props.item.id,
  () => {
    view.value = props.item.action === 'conflict' ? 'diff' : 'editor'
    warningsOpen.value = false
  },
)

/** The editor is read-only where the caller cannot act, and for a settled item. */
const editable = computed(() => props.canManage && props.item.status === 'staged')

/**
 * A comparison that never existed as two revisions, assembled to the shape
 * `DiffView` renders. The ids are the item's, not a revision's: nothing here
 * addresses a revision, and commenting — the only thing that would need one —
 * is off.
 */
const compare = computed<CompareResponse | null>(() => {
  const left = props.localHead
  // Nothing staged means there is no second side. Diffing the page against an
  // empty string would report every line deleted, which is the opposite of what
  // these two states mean.
  if (left === null || notFetched.value || agreed.value) return null
  const { hunks, additions, deletions } = lineDiff(left, markdown.value)
  return {
    documentId: props.item.documentId ?? '',
    from: { revisionId: `${props.item.id}:local`, revisionNumber: 0, branch: null, contentHash: null },
    to: { revisionId: `${props.item.id}:incoming`, revisionNumber: 0, branch: null, contentHash: null },
    comparisonMode: 'direct',
    mergeBaseRevisionId: null,
    summary: { additions, deletions },
    hunks,
    structural: null,
    semantic: null,
  }
})

const mentionablePages = computed(() =>
  documents.items.map((d) => ({ documentId: d.documentId, title: d.title, category: d.category })),
)

const empty = computed(() => markdown.value.trim().length === 0)

/**
 * Never submit stale text: the editor debounces, so the page flushes through
 * here before it reads the markdown — the `ImportReview` contract exactly.
 */
defineExpose({
  flush(): string {
    markdown.value = editorRef.value?.flush() ?? markdown.value
    return markdown.value
  },
})
</script>

<template>
  <div class="kn-page-body">
    <div class="kn-page-main relative">
      <!-- A conflict opens here; the editor is one click away and is what the
           merge assist writes into. -->
      <div v-if="compare" class="absolute top-3 right-4 z-10 flex gap-1 rounded-md border bg-background p-0.5 shadow-xs">
        <button
          v-for="mode in (['diff', 'editor'] as const)"
          :key="mode"
          type="button"
          class="rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
          :class="view === mode ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'"
          :aria-pressed="view === mode"
          @click="view = mode"
        >
          {{ mode === 'diff' ? t('connectors.viewChanges') : t('connectors.viewPage') }}
        </button>
      </div>

      <div v-if="compare && view === 'diff'" class="h-full overflow-y-auto px-6 py-6 lg:px-10">
        <div class="mx-auto max-w-4xl space-y-4">
          <header>
            <h2 class="font-medium">{{ title }}</h2>
            <p class="text-muted-foreground text-sm">{{ t('connectors.diffCaption') }}</p>
          </header>
          <DiffView :compare="compare" />
        </div>
      </div>

      <!-- The walk found this page but has not read it. Filling one page (or one
           branch, from the tree) is what makes a stopped walk workable, so the
           way out of this state is offered here rather than only in the tree. -->
      <div v-else-if="notFetched" class="grid h-full place-items-center px-6">
        <div class="max-w-sm space-y-3 text-center">
          <CloudDownload class="text-muted-foreground mx-auto size-8" aria-hidden="true" />
          <h2 class="font-medium">{{ t('connectors.notFetchedTitle') }}</h2>
          <p class="text-muted-foreground text-sm">{{ t('connectors.notFetchedBody') }}</p>
          <Button v-if="canManage" variant="outline" size="sm" @click="emit('fetch')">
            {{ t('connectors.event.fetch') }}
          </Button>
        </div>
      </div>

      <!-- Both sides already agree, so nothing was staged and nothing would be
           written. The page itself is what there is to show — an empty pane here
           reads as a failed conversion, which is the opposite of the truth. -->
      <div v-else-if="agreed" class="flex h-full min-h-0 flex-col">
        <p class="text-muted-foreground shrink-0 border-b px-6 py-2 text-xs lg:px-10">
          {{ t('connectors.agreedNote') }}
        </p>
        <div class="min-h-0 flex-1">
          <RichEditor :model-value="localHead ?? ''" :editable="false" :pages="mentionablePages">
            <template #lede>
              <h1 class="kn-title-input">{{ title }}</h1>
            </template>
          </RichEditor>
        </div>
      </div>

      <RichEditor
        v-else
        ref="editorRef"
        v-model="markdown"
        :editable="editable"
        :pages="mentionablePages"
      >
        <template #lede>
          <textarea
            v-model="title"
            class="kn-title-input"
            rows="1"
            :readonly="!editable"
            :placeholder="t('connectors.itemTitle')"
            :aria-label="t('connectors.itemTitle')"
            spellcheck="false"
            @keydown.enter.prevent="editorRef?.focus()"
          />
          <p v-if="empty" class="text-muted-foreground mt-2 text-sm">
            {{ t('connectors.conversionEmpty') }}
          </p>
        </template>
      </RichEditor>
    </div>

    <aside class="kn-item-rail">
      <!-- Provenance: what this is, and where it sits in the external tree. -->
      <section class="space-y-3 border-b p-4">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold">{{ t('connectors.itemProvenance') }}</h2>
          <span
            v-if="item.action"
            class="inline-flex items-center gap-1 text-xs font-medium"
            :class="ACTION_CLASS[item.action]"
          >
            <component :is="ACTION_ICON[item.action]" class="size-3.5" aria-hidden="true" />
            {{ t(ACTION_LABEL[item.action]) }}
          </span>
        </div>

        <dl class="space-y-1.5 text-sm">
          <div class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{{ t('connectors.itemState') }}</dt>
            <dd>{{ t(ITEM_STATUS_LABEL[item.status]) }}</dd>
          </div>
          <div v-if="item.externalVersion" class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{{ t('connectors.externalVersion') }}</dt>
            <dd class="tabular-nums">{{ item.externalVersion }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{{ t('connectors.treeDepth') }}</dt>
            <dd class="tabular-nums">{{ item.depth }}</dd>
          </div>
        </dl>

        <a
          v-if="item.externalUrl"
          :href="item.externalUrl"
          target="_blank"
          rel="noreferrer noopener"
          class="text-primary inline-flex items-center gap-1.5 text-sm hover:underline"
        >
          <ExternalLink class="size-3.5" aria-hidden="true" />
          {{ t('connectors.openInSource') }}
        </a>

        <!-- A page a model rewrote must never be indistinguishable from one the
             external system sent. The badge says which assist, and the original
             conversion is still on the server under `incoming`. -->
        <p
          v-if="item.aiOp"
          class="flex items-start gap-2 rounded-md border border-violet-500/25 bg-violet-500/5 p-2 text-xs text-violet-800 dark:border-violet-400/20 dark:text-violet-200"
        >
          <Sparkles class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ t(`connectors.aiBadge.${item.aiOp}`) }}</span>
        </p>
        <p v-else-if="item.edited" class="text-muted-foreground text-xs">{{ t('connectors.editedByHand') }}</p>

        <p v-if="item.error" class="text-destructive text-xs">{{ item.error }}</p>
      </section>

      <!-- What the conversion could not carry. Never swallowed. -->
      <section
        v-if="item.warnings.length"
        class="border-b border-amber-500/25 bg-amber-500/5 p-4 text-sm dark:border-amber-400/20"
      >
        <p class="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle class="size-4 shrink-0" aria-hidden="true" />
          {{ t('connectors.thingsToCheck', { count: item.warnings.length }, item.warnings.length) }}
        </p>
        <ul class="mt-2 space-y-1.5 text-amber-900/90 dark:text-amber-100/80">
          <li v-for="w in item.warnings.slice(0, 2)" :key="w" class="flex gap-2">
            <span class="mt-2 size-1 shrink-0 rounded-full bg-current opacity-60" aria-hidden="true" />
            <span>{{ w }}</span>
          </li>
        </ul>
        <Collapse :open="warningsOpen" :unmount="false">
          <ul class="space-y-1.5 text-amber-900/90 dark:text-amber-100/80">
            <li v-for="w in item.warnings.slice(2)" :key="w" class="flex gap-2 pt-1.5">
              <span class="mt-2 size-1 shrink-0 rounded-full bg-current opacity-60" aria-hidden="true" />
              <span>{{ w }}</span>
            </li>
          </ul>
        </Collapse>
        <button
          v-if="item.warnings.length > 2"
          type="button"
          class="mt-2 flex items-center gap-1 text-xs font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-300"
          @click="warningsOpen = !warningsOpen"
        >
          {{ warningsOpen ? t('editor.showFewer') : t('editor.showAll', { n: item.warnings.length }) }}
          <ChevronDown class="size-3 transition-transform duration-150" :class="warningsOpen && 'rotate-180'" />
        </button>
      </section>

      <!-- Never automatic: both of these are asked for, one item at a time. -->
      <section v-if="canManage && item.status === 'staged'" class="space-y-3 p-4">
        <h2 class="text-sm font-semibold">{{ t('connectors.aiAssist') }}</h2>
        <p class="text-muted-foreground text-xs">{{ t('connectors.aiAssistHint') }}</p>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" :disabled="aiBusy !== null" @click="emit('ai', 'cleanup')">
            <component :is="aiBusy === 'cleanup' ? Loader2 : Wand2" class="size-4" :class="aiBusy === 'cleanup' && 'animate-spin'" aria-hidden="true" />
            {{ t('connectors.aiCleanup') }}
          </Button>
          <!-- Merging needs a base and a second side; only a conflict has both. -->
          <Button
            v-if="isConflict"
            variant="outline"
            size="sm"
            :disabled="aiBusy !== null"
            @click="emit('ai', 'merge')"
          >
            <component :is="aiBusy === 'merge' ? Loader2 : GitMerge" class="size-4" :class="aiBusy === 'merge' && 'animate-spin'" aria-hidden="true" />
            {{ t('connectors.aiMerge') }}
          </Button>
        </div>
      </section>

      <section v-if="incoming" class="border-t p-4">
        <details>
          <summary class="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
            <FileText class="size-3.5" aria-hidden="true" />
            {{ t('connectors.showOriginalConversion') }}
          </summary>
          <pre class="text-muted-foreground mt-2 max-h-80 overflow-auto rounded-md border bg-muted/40 p-2 text-[11px] whitespace-pre-wrap">{{ incoming }}</pre>
        </details>
      </section>
    </aside>
  </div>
</template>

<style scoped>
/*
 * The import review's measure, for the import review's reason: this is checking
 * a conversion against a document you already know, scanning headings and
 * tables rather than composing sentences, and the rail already takes 24–28rem.
 */
.kn-page-main {
  --kn-measure: 58rem;
}

.kn-page-main :deep(.kn-editor-content) {
  padding-inline: 2rem;
}

@media (max-width: 1023px) {
  .kn-page-body {
    flex-direction: column;
    overflow-y: auto;
  }
}

.kn-item-rail {
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
  .kn-item-rail {
    width: 28rem;
  }
}

@media (max-width: 1023px) {
  .kn-item-rail {
    width: 100%;
    overflow-y: visible;
    border-top: 1px solid var(--border);
    border-left: none;
  }
}
</style>
