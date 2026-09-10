<script setup lang="ts">
/**
 * A document, as a reader meets it — on its own page, or at a merge request's
 * source head in review (features 13 and 15).
 *
 * The content is the editor in read mode — the same component that writes the
 * page renders it, so what you read is literally what you would edit: live
 * diagrams, whiteboards, tables and expands rather than a static copy of them.
 *
 * On top of that sits commenting, the way an annotated PDF or a Figma frame
 * works: select a passage, a Comment affordance appears at the selection, and
 * the commented passage stays highlighted with its comment count until the
 * discussion is resolved. Highlights are ProseMirror decorations (see
 * extensions/comment-anchors) rather than injected markup, because the editor
 * owns its DOM and would reconcile anything written into it from outside.
 *
 * There are two ways in. Selecting a passage comments on exactly that passage.
 * Hovering a block reveals a control in the margin beside it, which comments on
 * the whole block — the same affordance Notion, Figma and Docs use, and the
 * reason none of them open a composer on hover itself: a box that appears
 * wherever the pointer rests would fire continuously while someone is reading.
 *
 * The floating layer is positioned inside this component rather than the
 * viewport, so it scrolls with the passage it belongs to, and is marked
 * `data-kn-anno-ui` so its own text can never end up inside an anchor quote.
 */
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MessageSquarePlus, X } from 'lucide-vue-next'
import type {
  GlossaryExclusion,
  GlossaryTerm,
  ListGlossaryExclusionsResponse,
  ReviewThread,
  ReviewThreadAnchor,
} from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import RichEditor from '@/components/editor/RichEditor.vue'
import {
  ANCHOR_ATTR,
  anchorFromDomSelection,
  anchorFromQuote,
  anchorFromRange,
  anchorsAtEvent,
  type AnchorAuthor,
  type CommentAnchor,
} from '@/components/editor/extensions/comment-anchors'
import type { TextAnchor } from '@/lib/anchor-match'
import { slugifyHeading } from '@/lib/markdown/render'
import ThreadCard from '@/components/merge-requests/ThreadCard.vue'
import CommentComposer from '@/components/merge-requests/CommentComposer.vue'
import { useMembers } from '@/components/merge-requests/use-members'
import { useAnchoredFloating, type AnchorRect } from '@/lib/use-anchored'
import { mayContainPageRef } from '@/lib/page-refs'
import { usePageRefsStore } from '@/stores/page-refs'
import { useGlossaryStore } from '@/stores/glossary'
import { apiFetch, getGlossaryLinks, setGlossaryLinks } from '@/lib/api'
import { GLOSSARY_AT_ATTR, GLOSSARY_ATTR } from '@/lib/glossary'
import GlossaryCard from './GlossaryCard.vue'
import { useMediaQuery } from '@vueuse/core'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    markdown: string
    /** The page being read. Needed so a term cannot link to its own page. */
    documentId: string
    /** The document's title, so the body does not repeat it. */
    title?: string
    /** Revision the anchors are recorded against (the head being read). */
    revisionId: string
    threads: ReviewThread[]
    canComment?: boolean
    busy?: boolean
    resolveDocumentId?: () => Promise<string | null>
    /** The page's own frontmatter — read for `glossary: false` (feature 14). */
    frontmatter?: Record<string, unknown> | null
  }>(),
  {
    title: '',
    canComment: false,
    busy: false,
    resolveDocumentId: undefined,
    frontmatter: null,
  },
)
const emit = defineEmits<{
  'create-thread': [body: string, anchor: ReviewThreadAnchor | undefined, resolvable: boolean]
  reply: [threadId: string, body: string, replyToId: string | null]
  resolve: [threadId: string, resolved: boolean]
  edit: [threadId: string, commentId: string, body: string]
  delete: [threadId: string, commentId: string]
  /** Anchored threads whose passage no longer exists on the page. */
  outdated: [threadIds: string[]]
  headings: [headings: { id: string; text: string; level: number }[]]
}>()

interface Floater {
  top: number
  left: number
}

/**
 * The page body, with its own title removed.
 *
 * `documents.title` is the canonical title and the page header renders it, but
 * almost every page also opens with `# Same Title` because that is what writing
 * markdown looks like — so the reader met the title twice. The heading is
 * dropped only when it actually matches; a first heading that says something
 * else is a real section and stays.
 */
/**
 * The roster behind `[text](Exact Page Title)` references (lib/page-refs).
 * Fetched only when this page actually contains a candidate, so an ordinary
 * page costs nothing; RichEditor re-parses when it lands.
 */
const pageRefs = usePageRefsStore()
/**
 * Vocabulary linking (docs/features/14). The roster is workspace/project-wide
 * and shared with the glossary page, so this only has to ask for it.
 */
const glossary = useGlossaryStore()
onMounted(() => void glossary.ensureLoaded())


/**
 * The vocabulary this page links, after three gates.
 *
 * A term defined *by this page* is dropped: the link would go where the reader
 * already is, and on a glossary page it turns every entry into a link to
 * itself. The page can opt out wholesale with `glossary: false` in its
 * frontmatter, and the reader can turn linking off for themselves — the reader
 * wins, because a preference someone set should survive a page that merely has
 * a default.
 */
const glossaryTerms = computed(() => {
  if (!linksOn.value) return []
  if (props.frontmatter?.glossary === false) return []
  return glossary.linkable.filter((term) => term.documentId !== props.documentId)
})
watch(
  () => props.markdown,
  (markdown) => {
    if (mayContainPageRef(markdown ?? '')) void pageRefs.ensureLoaded()
  },
  { immediate: true },
)

const body = computed(() => {
  const raw = props.markdown ?? ''
  const title = props.title?.trim().toLowerCase()
  if (!title) return raw
  return raw.replace(/^\s*#\s+(.+?)\s*(\n|$)/, (match, heading: string) =>
    heading.trim().toLowerCase() === title ? '' : match,
  )
})

const canvas = ref<HTMLElement | null>(null)
const page = ref<HTMLElement | null>(null)
const editorEl = ref<InstanceType<typeof RichEditor> | null>(null)

/* ------------------------------------------------------ glossary linking */

/** The reader's own preference, from `kn_glossary`. */
const linksOn = ref(getGlossaryLinks())
function toggleGlossaryLinks() {
  linksOn.value = !linksOn.value
  setGlossaryLinks(linksOn.value)
}

/**
 * Whether this page has any vocabulary in it, so the control can stay hidden
 * on pages that have none — a switch for something the page does not do is
 * noise. Once linking is off there is nothing to count, so the flag is left
 * standing rather than recomputed, or the control would remove itself and
 * leave no way back.
 */

/* --- per-occurrence exclusions ------------------------------------------ */

/**
 * Loaded per page, and only for a page that has vocabulary in it at all — the
 * roster is workspace-wide and cached, but exclusions are about *this* page, so
 * they cannot ride it. A page with no glossary matches should cost no request.
 */
const exclusions = ref<GlossaryExclusion[]>([])

async function loadExclusions() {
  if (!props.documentId) return
  try {
    const res = await apiFetch<ListGlossaryExclusionsResponse>(
      `/v1/documents/${props.documentId}/glossary-exclusions`,
    )
    exclusions.value = res.exclusions
  } catch {
    // Linking is an enhancement and the prose is already on screen — the same
    // reason the glossary store swallows its own failures.
    exclusions.value = []
  }
}
watch(() => props.documentId, () => void loadExclusions(), { immediate: true })

/**
 * Record the occurrence under the card as "not this term".
 *
 * The quote and its context come from the *document projection*, not from the
 * DOM: text the document has no record of could never be found again, so an
 * anchor built from it would be recorded and never resolve.
 */
async function excludeHovered() {
  const term = hoveredTerm.value
  const doc = editorEl.value?.editor?.state.doc
  const el = hoveredEl.value
  if (!term || !doc || !el) return
  const at = el.getAttribute(GLOSSARY_AT_ATTR)
  const from = at === null ? Number.NaN : Number(at)
  const anchor = Number.isFinite(from)
    ? anchorFromRange(doc, from, from + (el.textContent ?? '').length)
    : null
  if (!anchor) {
    // The occurrence could not be located in the document projection, so an
    // exclusion recorded for it would never resolve again. Better to say so.
    toast.error(t('glossary.cannotExclude'))
    return
  }
  hideGlossary()
  try {
    const created = await apiFetch<GlossaryExclusion>(
      `/v1/documents/${props.documentId}/glossary-exclusions`,
      {
        method: 'POST',
        body: JSON.stringify({
          termId: term.termId,
          anchor,
        }),
      },
    )
    exclusions.value = [...exclusions.value, created]
  } catch (error) {
    // Unlike loading, this is something someone just asked for: a link that
    // silently stays looks like the button does nothing.
    toast.error((error as Error).message)
  }
}

/* --- the definition card ----------------------------------------------- */

/**
 * Hover on a pointer device, tap otherwise — the `UserChip` split. It cannot
 * reuse `HoverCard` itself: that wraps its trigger, and the trigger here is a
 * ProseMirror decoration, which is not a component and cannot be wrapped. So
 * the card is a canvas-owned floating layer, positioned the same way the
 * discussion popover above it is.
 */
const canHover = useMediaQuery('(hover: hover)')
const hoveredTerm = ref<GlossaryTerm | null>(null)
/** The `<a>` the card hangs off, so an exclusion can quote exactly it. */
const hoveredEl = ref<Element | null>(null)
const glossaryAt = ref<AnchorRect | null>(null)
const { setFloating: setGlossaryEl, floatingStyles: glossaryStyles } = useAnchoredFloating(
  glossaryAt,
  { placement: 'bottom-start' },
)

/**
 * HoverCard's own delays, copied deliberately: a pointer crossing a paragraph
 * passes over several terms on its way somewhere, and a card that opened
 * instantly would strobe. The close delay is what lets the pointer travel from
 * the word into the card without it dissolving on the way.
 */
let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined

function termAt(target: EventTarget | null): { term: GlossaryTerm; el: Element } | null {
  const el = target instanceof Element ? target.closest(`[${GLOSSARY_ATTR}]`) : null
  if (!el) return null
  const termId = el.getAttribute(GLOSSARY_ATTR)
  const term = glossary.terms.find((x) => x.termId === termId)
  return term ? { term, el } : null
}

function showGlossary(hit: { term: GlossaryTerm; el: Element }) {
  clearTimeout(closeTimer)
  hoveredTerm.value = hit.term
  hoveredEl.value = hit.el
  glossaryAt.value = toRect(hit.el.getBoundingClientRect())
}

function hideGlossary() {
  clearTimeout(openTimer)
  hoveredTerm.value = null
  hoveredEl.value = null
  glossaryAt.value = null
}

function onGlossaryOver(event: PointerEvent) {
  if (!canHover.value) return
  const hit = termAt(event.target)
  if (!hit) return
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  openTimer = setTimeout(() => showGlossary(hit), 220)
}

function onGlossaryOut(event: PointerEvent) {
  if (!canHover.value) return
  if (!termAt(event.target)) return
  clearTimeout(openTimer)
  closeTimer = setTimeout(hideGlossary, 120)
}

/**
 * On a touch device the term is a link, so opening the card has to take the
 * tap away from it — the definition is what someone reaching for a dotted word
 * on a phone is after, and the card carries the link onward anyway.
 */
function onGlossaryClick(event: MouseEvent): boolean {
  if (canHover.value) return false
  const hit = termAt(event.target)
  if (!hit) return false
  event.preventDefault()
  if (hoveredTerm.value?.termId === hit.term.termId) hideGlossary()
  else showGlossary(hit)
  return true
}

onBeforeUnmount(() => {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
})

const hasGlossary = ref(false)
watch(
  [() => props.markdown, glossaryTerms],
  () => {
    if (!linksOn.value) return
    void nextTick(() => {
      hasGlossary.value = !!page.value?.querySelector(`[${GLOSSARY_ATTR}]`)
    })
  },
  { immediate: true },
)

/** Where the "Comment" affordance sits while a selection is live. */
const selectionAt = ref<AnchorRect | null>(null)
const pendingAnchor = ref<TextAnchor | null>(null)
/** A composer is open for a new thread (anchored or not). */
const composing = ref(false)
/** The block under the pointer: where its comment control sits, and its text. */
const hoverAt = ref<Floater | null>(null)
/** Bottom of that block, so a composer opens below it rather than across it. */
const hoverBottom = ref(0)
/** Same block, in viewport space, for the composer that opens off it. */
const hoverRect = ref<AnchorRect | null>(null)
const hoverQuote = ref<string | null>(null)
/** The open discussion popover: which threads, and where. */
const openThreadIds = ref<string[]>([])
const popoverAt = ref<AnchorRect | null>(null)

/*
 * Two anchored surfaces, both on Floating UI with the `absolute` strategy so
 * they travel with the passage. `flip` turns the popover upwards when the
 * passage sits near the foot of the window; `shift` keeps a wide one inside the
 * page instead of running off its right edge.
 */
const { setFloating: setSelectionEl, floatingStyles: selectionStyles } = useAnchoredFloating(
  selectionAt,
  { placement: 'bottom-start', gap: 6, strategy: 'absolute' },
)
const { setFloating: setPopoverEl, floatingStyles: popoverStyles } = useAnchoredFloating(
  popoverAt,
  { placement: 'bottom-start', gap: 6, strategy: 'absolute' },
)

const byId = computed(() => new Map(props.threads.map((t) => [t.threadId, t])))
const openThreads = computed(() =>
  openThreadIds.value.map((id) => byId.value.get(id)).filter((t): t is ReviewThread => !!t),
)

/** Only anchored threads are drawn on the text; the rest live in the list below. */
const { nameOf } = useMembers()

const anchors = computed<CommentAnchor[]>(() =>
  props.threads
    .filter((t) => t.anchor?.type === 'text')
    .map((t) => ({
      id: t.threadId,
      anchor: t.anchor as TextAnchor,
      resolved: t.resolved,
      count: t.comments.length,
      authors: authorsOf(t),
    })),
)

/**
 * The faces a pin wears: distinct participants, oldest first. An assistant
 * review posts under the identity of whoever ran it, so a thread marked `ai`
 * contributes one glyph instead of that person's face — otherwise a machine
 * finding would look like a colleague's remark.
 */
function authorsOf(thread: ReviewThread): AnchorAuthor[] {
  if (thread.source === 'ai') return [{ userId: 'ai', name: t('assistant.name'), ai: true }]
  const seen = new Set<string>()
  const out: AnchorAuthor[] = []
  for (const comment of thread.comments) {
    if (seen.has(comment.authorId)) continue
    seen.add(comment.authorId)
    out.push({ userId: comment.authorId, name: nameOf(comment.authorId) })
  }
  return out
}

/**
 * Viewport rect → the shape Floating UI anchors to.
 *
 * This used to convert into canvas coordinates and clamp the left edge to zero
 * by hand — which is not collision detection: a popover on a passage near the
 * foot of the page still rendered below it and off screen, and one near the
 * right edge still overflowed. `flip` and `shift` do that properly now, and
 * because the strategy is `absolute` the panel still scrolls with the passage
 * it annotates instead of detaching from it.
 */
function toRect(rect: DOMRect): AnchorRect {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

/* ------------------------------------------------------ hover to comment */

/**
 * Track the block under the pointer and park a control beside it.
 *
 * Anything already asking for attention wins: a live selection is a more
 * precise intent than a hover, and an open popover must not have a button
 * flickering underneath it.
 */
function onPageMove(event: MouseEvent) {
  const root = page.value
  if (!props.canComment || !root) return
  if (composing.value || openThreadIds.value.length > 0 || selectionAt.value) {
    hoverAt.value = null
    return
  }
  const target = event.target instanceof Element ? event.target : null
  const block = target?.closest('.kn-prose > *')
  /*
   * Travelling to the control means leaving the block that summoned it: the
   * pointer crosses the gutter, where the target is the padding rather than any
   * block, and then the button itself. Clearing on either kills the thing the
   * pointer is reaching for — so the control persists until another block
   * claims it, and only leaving the article dismisses it. This is the whole
   * reason a hover affordance is hard, and why "no block here" must mean
   * "nothing changed" rather than "nothing is hovered".
   */
  if (!block || !root.contains(block)) return
  // A diagram or a whiteboard holds nothing the document can quote, so it gets
  // no control rather than one that fails on click.
  const text = quotableText(block)
  if (!text) {
    hoverAt.value = null
    return
  }
  const host = canvas.value
  if (!host) return
  const base = host.getBoundingClientRect()
  const rect = block.getBoundingClientRect()
  hoverQuote.value = text
  hoverAt.value = { top: rect.top - base.top, left: rect.left - base.left }
  hoverBottom.value = rect.bottom - base.top
  hoverRect.value = toRect(rect)
}

/**
 * The block's text as the *document* has it.
 *
 * `textContent` would also collect what the annotation layer drew into the
 * block — a comment-count pin renders as a real text node — and a quote ending
 * in a stray "1" matches nothing in the document, so the block silently became
 * uncommentable once someone commented on it.
 */
function quotableText(block: Element): string {
  const clone = block.cloneNode(true) as Element
  for (const ui of clone.querySelectorAll('.kn-anchor-pin, [data-kn-anno-ui]')) ui.remove()
  return (clone.textContent ?? '').trim()
}

function startBlockThread() {
  const doc = editorEl.value?.editor?.state.doc
  if (!doc || !hoverQuote.value) return
  pendingAnchor.value = anchorFromQuote(doc, props.revisionId, hoverQuote.value)
  composing.value = true
  popoverAt.value = hoverRect.value
  hoverAt.value = null
}

/**
 * Scroll a commented passage into view and flash it.
 *
 * Called from outside the reader — a jump from the rail — where the passage is
 * usually off screen. The flash is the whole point: arriving at a paragraph
 * without knowing which words were commented on is the same as not arriving.
 */
function flashThread(threadId: string) {
  const el = page.value?.querySelector<HTMLElement>(`[${ANCHOR_ATTR}="${threadId}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('kn-anchor-flash')
  window.setTimeout(() => el.classList.remove('kn-anchor-flash'), 1400)
}
defineExpose({ flashThread, toggleGlossaryLinks, hasGlossary, glossaryOn: linksOn })

function readSelection() {
  if (!props.canComment) return
  const doc = editorEl.value?.editor?.state.doc
  const root = page.value
  if (!doc || !root) return

  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    selectionAt.value = null
    return
  }
  // A selection that started in the popover is someone reading a comment, not
  // someone marking up the page.
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) {
    selectionAt.value = null
    return
  }
  // A selection the document has no text for — a diagram's rendered labels,
  // say — cannot be pinned. Offering the comment unanchored beats a Comment
  // button that silently refuses to appear.
  pendingAnchor.value = anchorFromDomSelection(doc, props.revisionId)
  selectionAt.value = toRect(range.getBoundingClientRect())
}

function startThread() {
  composing.value = true
  popoverAt.value = selectionAt.value
  openThreadIds.value = []
  selectionAt.value = null
  window.getSelection()?.removeAllRanges()
}

function openAt(target: EventTarget | null): boolean {
  const ids = anchorsAtEvent(target)
  if (ids.length === 0) return false
  const mark = (target as Element).closest(`[data-kn-thread]`)
  openThreadIds.value = ids
  pendingAnchor.value = null
  composing.value = false
  popoverAt.value = mark ? toRect(mark.getBoundingClientRect()) : null
  return true
}

function onPageClick(event: MouseEvent) {
  // A highlight is a control, not a link: clicking one opens the discussion
  // rather than the surrounding prose's link, if any.
  if (openAt(event.target)) event.preventDefault()
  else onGlossaryClick(event)
}

function onPageKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (openAt(event.target)) event.preventDefault()
}

function closePopover() {
  openThreadIds.value = []
  pendingAnchor.value = null
  composing.value = false
  popoverAt.value = null
  hoverQuote.value = null
}

function submitNewThread(body: string, resolvable: boolean) {
  emit('create-thread', body, pendingAnchor.value ?? undefined, resolvable)
  closePopover()
}

/**
 * A press anywhere else dismisses the popover — the third way out, beside
 * Escape and the ✕.
 *
 * Bound to `pointerdown` on the document rather than vueuse's
 * `onClickOutside`, because a highlight *opens* the popover on click: a
 * listener watching `click` would see the very press that opened a discussion
 * and shut it again inside the same gesture. Presses on another highlight are
 * left alone so the popover switches passages instead of closing, and the
 * annotation layer and any teleported editor UI (link dialog, slash menu,
 * dropdowns) are excluded — those are the composer, not somewhere else.
 */
function onDocumentPointerDown(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : null
  if (!target) return
  if (
    target.closest(
      `[data-kn-anno-ui], [data-kn-editor-ui], [data-kn-thread], [${GLOSSARY_ATTR}], [role="dialog"], [role="menu"], [data-reka-popper-content-wrapper]`,
    )
  ) {
    return
  }
  closePopover()
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closePopover()
}

onMounted(() => {
  document.addEventListener('keydown', onDocumentKeydown)
  document.addEventListener('pointerdown', onDocumentPointerDown)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKeydown)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})

/**
 * "On this page", read back off the rendered editor.
 *
 * The read surface is a ProseMirror document, and its headings carry no ids —
 * so the ids are assigned here, from the heading text, the same way the static
 * renderer slugifies them. That keeps deep links to a section working across
 * both surfaces.
 */
function collectHeadings() {
  const root = page.value
  if (!root) return
  const seen = new Map<string, number>()
  const headings = [...root.querySelectorAll<HTMLElement>('.kn-prose h1, .kn-prose h2, .kn-prose h3')].map(
    (el) => {
      const text = el.textContent?.trim() ?? ''
      const base = slugifyHeading(text) || 'section'
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      const id = n === 1 ? base : `${base}-${n}`
      el.id = id
      return { id, text, level: Number(el.tagName.slice(1)) }
    },
  )
  emit('headings', headings)
}

// The editor mounts and re-parses asynchronously; headings are read once the
// text it produced is actually in the DOM.
watch(body, () => void nextTick().then(collectHeadings), { immediate: true })
onMounted(() => void nextTick().then(collectHeadings))

function onOutdated(ids: string[]) {
  emit('outdated', ids)
  // A thread whose passage vanished cannot keep a popover open over nothing —
  // but a composer is not open over a thread, and closing it here threw away
  // whatever was being written every time the decoration pass re-ran.
  if (ids.length === 0 || composing.value) return
  openThreadIds.value = openThreadIds.value.filter((id) => !ids.includes(id))
  if (openThreadIds.value.length === 0) popoverAt.value = null
}
</script>

<template>
  <div
    ref="canvas"
    class="kn-read-canvas relative"
    @mouseup="readSelection"
    @keyup="readSelection"
    @mousemove="onPageMove"
    @mouseleave="hoverAt = null"
  >
    <div
      ref="page"
      class="kn-read-surface"
      @click="onPageClick"
      @keydown="onPageKeydown"
      @pointerover="onGlossaryOver"
      @pointerout="onGlossaryOut"
    >
      <RichEditor
        ref="editorEl"
        :model-value="body"
        :editable="false"
        :resolve-page="pageRefs.resolve"
        :glossary-terms="glossaryTerms"
        :glossary-exclusions="exclusions"
        :comment-anchors="anchors"
        @outdated-anchors="onOutdated"
      />
    </div>

    <!-- Comment on the block under the pointer. Lives in the reading gutter,
         so it never covers the words it refers to. -->
    <button
      v-if="hoverAt && canComment"
      data-kn-anno-ui
      class="kn-comment-affordance absolute z-10 size-6 place-items-center rounded-md border bg-background text-muted-foreground opacity-70 shadow-sm transition-opacity hover:opacity-100"
      :style="{ top: `${hoverAt.top}px` }"
      :title="t('review.commentOnBlock')"
      :aria-label="t('review.commentOnBlock')"
      @click="startBlockThread"
    >
      <MessageSquarePlus class="size-3.5" />
    </button>

    <!-- Floating "comment on this", anchored to the live selection -->
    <div
      v-if="selectionAt && canComment"
      :ref="setSelectionEl"
      data-kn-anno-ui
      class="z-20"
      :style="selectionStyles"
    >
      <Button size="xs" class="shadow-md" @mousedown.prevent @click="startThread">
        <MessageSquarePlus class="size-3.5" />
        {{ t('review.comment') }}
      </Button>
    </div>

    <!--
      Definition card. `data-kn-anno-ui` keeps its own text out of comment
      anchor quotes, and the pointer handlers keep it open while the reader
      travels from the word into it.
    -->
    <div
      v-if="hoveredTerm && glossaryAt"
      :ref="setGlossaryEl"
      data-kn-anno-ui
      class="z-30 w-72 rounded-lg border bg-popover p-3 shadow-lg"
      :style="glossaryStyles"
      @pointerenter="hoveredEl && showGlossary({ term: hoveredTerm, el: hoveredEl })"
      @pointerleave="hideGlossary"
    >
      <GlossaryCard :term="hoveredTerm" :can-exclude="canComment" @exclude="excludeHovered" />
    </div>

    <!-- Discussion popover: the open threads, or a composer for a new one -->
    <div
      v-if="popoverAt && (openThreads.length || composing)"
      :ref="setPopoverEl"
      data-kn-anno-ui
      class="z-30 w-[38rem] space-y-2 overflow-y-auto rounded-lg border bg-popover p-2 shadow-lg"
      :style="popoverStyles"
      @click.stop
      @mouseup.stop
      @keyup.stop
      @mousemove.stop
    >
      <div class="flex items-start gap-2">
        <p v-if="composing && pendingAnchor" class="min-w-0 flex-1 text-xs text-muted-foreground">
          <i18n-t keypath="review.newCommentOnQuote" tag="span" scope="global">
            <template #quote>
              <span class="italic">{{ pendingAnchor.quote.slice(0, 90) }}</span
              >{{ pendingAnchor.quote.length > 90 ? '…' : '' }}
            </template>
          </i18n-t>
        </p>
        <p v-else-if="composing" class="min-w-0 flex-1 text-xs text-muted-foreground">
          {{ t('review.newCommentOnPage') }}
        </p>
        <p v-else class="min-w-0 flex-1 text-xs text-muted-foreground">
          {{ t('count.threads', { n: openThreads.length }, openThreads.length) }}{{ ' ' }}{{ t('review.onThisPassage') }}
        </p>
        <button
          class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          :aria-label="t('common.close')"
          @click="closePopover"
        >
          <X class="size-3.5" />
        </button>
      </div>

      <CommentComposer
        v-if="composing"
        auto-expand
        offer-thread
        :placeholder="t('review.writeComment')"
        :submit-label="t('review.comment')"
        :busy="busy"
        :resolve-document-id="resolveDocumentId"
        @submit="submitNewThread"
      />
      <div v-else class="max-h-[26rem] space-y-2 overflow-y-auto">
        <ThreadCard
          v-for="thread in openThreads"
          :key="thread.threadId"
          :thread="thread"
          :readonly="!canComment"
          :busy="busy"
          :resolve-document-id="resolveDocumentId"
          @reply="(b: string, p: string | null) => emit('reply', thread.threadId, b, p)"
          @resolve="(r: boolean) => emit('resolve', thread.threadId, r)"
          @edit="(c: string, b: string) => emit('edit', thread.threadId, c, b)"
          @delete="(c: string) => emit('delete', thread.threadId, c)"
        />
      </div>
    </div>
  </div>
</template>
