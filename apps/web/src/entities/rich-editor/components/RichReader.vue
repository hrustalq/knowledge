<script setup lang="ts">
/**
 * A page body as a reader meets it (#1280): the editor's own view, read-only,
 * without anything that writes. `RichEditor` with `editable: false` drew the
 * same thing but shipped the toolbar, menus, dialogs, drag handle, uploads and
 * AI suggestions to every reader. Both build from `contentExtensions`, so a
 * block either can draw, the other can too.
 */
import { nextTick, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Editor, EditorContent } from '@tiptap/vue-3'
import type { GlossaryExclusion, GlossaryTerm } from '@knowledge/contracts'
import type { PageRefResolver } from '@/entities/document'
import { markdownToHtml } from '@/core/markdown/render'
import { hydration, inertDocument, whenIdle } from '@/shared/utils/hydration'
import { createEditorLowlight, highlightMissingLanguages } from '../model/lowlight'
import { staticBodyHtml } from '../model/static-body'
import { contentExtensions } from './extensions/content'
import type { CommentAnchor } from './extensions/comment-anchors'
import C4StudioHost from './nodes/C4StudioHost.vue'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** Commented passages to highlight (feature 15) — see RichEditor's prop. */
    commentAnchors?: CommentAnchor[]
    /** Resolves `[text](Exact Page Title)` to a link (`lib/page-refs`). */
    resolvePage?: PageRefResolver
    /** Lines of the stored body held out before `modelValue`, for passage links (#708). */
    lineOffset?: number
    /** Vocabulary to link (docs/features/14). */
    glossaryTerms?: GlossaryTerm[]
    glossaryExclusions?: GlossaryExclusion[]
  }>(),
  {
    commentAnchors: () => [],
    glossaryTerms: () => [],
    glossaryExclusions: () => [],
  },
)
const emit = defineEmits<{
  /** Anchors whose passage is no longer in the text, after the last decoration pass. */
  'outdated-anchors': [ids: string[]]
  /** The editor exists and holds `modelValue`, parsed. */
  ready: []
}>()

const editor = shallowRef<Editor | null>(null)
const lowlight = createEditorLowlight()

const toHtml = (markdown: string) =>
  markdownToHtml(markdown, { resolvePage: props.resolvePage, lineOffset: props.lineOffset })

/** The body before the editor exists (#643): drawn on the server and by the hydrating render. */
const staticHtml = (() => {
  if (!(import.meta.env.SSR || hydration.active)) return ''
  const doc = inertDocument()
  return doc ? staticBodyHtml(toHtml(props.modelValue), doc) : ''
})()

let unmounted = false
// Hydrating, the static body is already on screen: building the view parses the whole page,
// so it waits for idle instead of lengthening the synchronous mount. A client navigation has
// nothing drawn yet and builds at once.
onMounted(() => (staticHtml ? whenIdle(build, 1000) : build()))

function build() {
  if (unmounted) return
  const instance = new Editor({
    editable: false,
    content: toHtml(props.modelValue),
    extensions: contentExtensions({ lowlight, t, undoRedo: false }),
    editorProps: {
      // RichEditor's attributes, so the read view's DOM and styles do not change.
      attributes: {
        role: 'textbox',
        class: 'kn-prose',
        spellcheck: 'true',
        'aria-multiline': 'true',
        'aria-label': t('editor.bodyLabel'),
      },
    },
  })
  editor.value = instance
  highlightMissingLanguages(instance, lowlight)
  syncCommentAnchors()
  syncGlossary()
  emit('ready')
}

function syncCommentAnchors() {
  const instance = editor.value
  if (!instance) return
  instance.commands.setCommentAnchors(props.commentAnchors)
  // The outdated set is written during the decoration pass, so it is read back after the redraw.
  void nextTick(() => {
    if (editor.value === instance) emit('outdated-anchors', [...instance.storage.commentAnchors.outdated])
  })
}

function syncGlossary() {
  editor.value?.commands.setGlossaryTerms(props.glossaryTerms, props.glossaryExclusions)
}

/** A new body, or the page-title roster landing (references resolve only once it has): re-parse. */
function reparse() {
  const instance = editor.value
  if (!instance) return
  instance.commands.setContent(toHtml(props.modelValue), { emitUpdate: false })
  highlightMissingLanguages(instance, lowlight)
  syncCommentAnchors()
  syncGlossary()
}

watch([() => props.modelValue, () => props.resolvePage, () => props.lineOffset], reparse)
watch(() => props.commentAnchors, syncCommentAnchors, { deep: true })
watch([() => props.glossaryTerms, () => props.glossaryExclusions], syncGlossary)

onBeforeUnmount(() => {
  unmounted = true
  editor.value?.destroy()
})

defineExpose({
  /** The live editor, for hosts that read the document (comment anchoring). */
  editor,
})
</script>

<template>
  <!-- RichEditor's shell, so the read view keeps its layout and styles. -->
  <div class="kn-editor" data-editable="false">
    <div class="kn-editor-surface">
      <div class="kn-editor-content">
        <EditorContent v-if="editor" :editor="editor" />
        <!-- The shape EditorContent draws, so the swap does not move the text. -->
        <div v-else-if="staticHtml"><div class="tiptap ProseMirror kn-prose" v-html="staticHtml" /></div>
      </div>
    </div>
    <!-- A C4 block full screen (#1244); its studio is a lazy chunk. -->
    <C4StudioHost v-if="editor" :editor="editor" />
  </div>
</template>
