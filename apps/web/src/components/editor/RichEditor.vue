<script setup lang="ts">
/**
 * The page editor.
 *
 * WYSIWYG on Tiptap, but **markdown stays the stored format**: the model in and
 * out of this component is markdown, converted through lib/markdown. That is
 * what lets the whole backend — heading-aware chunking, frontmatter relations,
 * structural diff, merge requests, the graph — keep working unchanged while the
 * authoring experience changes completely.
 *
 * Everything here is MIT: Tiptap's open-source core plus the four Pro
 * extensions rebuilt in this folder (drag handle, expand, file handling and
 * table of contents).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Subject, Subscription, animationFrameScheduler, auditTime, distinctUntilChanged, merge } from 'rxjs'
import { useI18n } from 'vue-i18n'
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { Editor, EditorContent } from '@tiptap/vue-3'
import type { Editor as CoreEditor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import {
  AtSign,
  Bot,
  Code,
  Columns2,
  CopyPlus,
  Columns3,
  FileText,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Info,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Paperclip,
  PenLine,
  Plus,
  Quote,
  Route,
  Square,
  Table2,
  Trash2,
  Type,
  Workflow,
} from 'lucide-vue-next'
import { markdownToHtml } from '@/lib/markdown/render'
import type { GlossaryExclusion, GlossaryTerm } from '@knowledge/contracts'
import type { PageRefResolver } from '@/lib/page-refs'
import { fromWatch } from '@/lib/rx-vue'
import { PANEL_META, PANEL_TYPES, type PanelType } from '@/lib/markdown/nodes'
import { Layout, LayoutColumn, Expand, Panel, TableOfContents } from './extensions/blocks'
import { ApiContract, ApiSection } from './extensions/api'
import { Drawing, FileEmbed, Mermaid, ResizableImage } from './extensions/media'
import { AgentMention, DocMention, StatusMark, UserMention } from './extensions/inline'
import { createSuggestionExtension, type SuggestionSession } from './extensions/suggestion'
import {
  createDragHandle,
  deleteBlock,
  duplicateBlock,
  selectBlock,
  startBlockDrag,
} from './extensions/drag-handle'
import { ListIndentKeymap } from './extensions/list-indent'
import { CommentAnchors, type CommentAnchor } from './extensions/comment-anchors'
import { GlossaryTerms } from './extensions/glossary-terms'
import { useAttachments } from './use-attachments'
import {
  EMPTY_FORMAT,
  createMarkdownSync,
  docToMarkdown,
  editorStreams,
  shallowEqual,
  type FormatState,
  type MarkdownSync,
} from './editor-streams'
import CommandMenu, { type CommandItem } from './CommandMenu.vue'
import PagePickerDialog from './PagePickerDialog.vue'
import LinkDialog from './LinkDialog.vue'
import EditorToolbar from './EditorToolbar.vue'
import EditorBubble from './EditorBubble.vue'
import TableControls from './TableControls.vue'

export interface MentionablePage {
  documentId: string
  title: string
  category?: string
}

/** A workspace member `@` can name. `hint` is shown muted beside the name. */
export interface MentionablePerson {
  userId: string
  name: string
  hint?: string
}

/**
 * An AI agent `@` can bring into a discussion (docs/features/21).
 *
 * Keyed, not identified: an agent is a configuration, and the built-in ones
 * have no database row at all until a workspace overrides them.
 */
export interface MentionableAgent {
  key: string
  name: string
  description?: string
}

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    modelValue: string
    pages?: MentionablePage[]
    /**
     * People `@` can name. Offered above pages, because that is what the
     * sigil means everywhere else and the page picker also has `/` and a
     * toolbar button while a person has only this.
     */
    people?: MentionablePerson[]
    /**
     * Agents `@` can tag. Offered last, under people and pages: mentioning one
     * spends a model call, so it should be the deliberate choice in the menu
     * rather than the one the cursor lands on.
     */
    agents?: MentionableAgent[]
    editable?: boolean
    /** Resolves (creating if needed) the document attachments belong to. */
    resolveDocumentId?: () => Promise<string | null>
    placeholder?: string
    /**
     * Comment-box mode: same editor, page furniture removed. No toolbar, no
     * drag gutter, no table controls, and the slash menu is trimmed to the
     * blocks that make sense in a review comment — a column layout or a
     * whiteboard inside a two-sentence reply is not a feature.
     * Selection formatting and `/` still work, which is the whole point of
     * having a real editor here rather than a textarea.
     */
    compact?: boolean
    /**
     * Commented passages to highlight (feature 15). Drawn as ProseMirror
     * decorations, so they survive editing and never fight the view's own DOM.
     * The host owns the discussion UI; this component only marks the text.
     */
    commentAnchors?: CommentAnchor[]
    /**
     * Resolves a page reference written as a title (`lib/page-refs`). Supplied
     * by read surfaces only — `toHtml` explains why an editor must not have it.
     * Separate from `pages`, which is the `@` menu's roster: that one is a list
     * to choose from, this one is an index, and the read view needs the index
     * without offering the menu.
     */
    resolvePage?: PageRefResolver
    /**
     * Vocabulary to link (docs/features/14). Read surfaces only — while a page
     * is being written, a definition link under every third word fights the
     * text selection it sits in, and the affordance is for readers anyway.
     * Decorations, so nothing is written to the document either way.
     */
    glossaryTerms?: GlossaryTerm[]
    /** Occurrences on this page that are not mentions, despite matching. */
    glossaryExclusions?: GlossaryExclusion[]
  }>(),
  {
    pages: () => [],
    people: () => [],
    agents: () => [],
    editable: true,
    compact: false,
    placeholder: '',
    commentAnchors: () => [],
    glossaryTerms: () => [],
    glossaryExclusions: () => [],
  },
)
const emit = defineEmits<{
  'update:modelValue': [string]
  /** Anchors whose passage is no longer in the text, after the last decoration pass. */
  'outdated-anchors': [ids: string[]]
  /** The editor exists and holds `modelValue`, parsed. */
  ready: []
}>()

const editor = shallowRef<Editor | null>(null)
const rootEl = ref<HTMLElement | null>(null)
/**
 * Compact boxes earn their toolbar by being written in.
 *
 * A comment box is a single line at rest; a formatting bar parked above every
 * one of them would out-weigh the thread it sits in. So the bar appears once
 * the box is actually being written in and stays until the writing is done —
 * "focused" in the useful sense, not the DOM one: clicking Bold, opening the
 * link dialog or picking a page all move focus off the editor for a moment,
 * and a bar that vanished mid-gesture would be unusable. Only a press outside
 * the whole editor (menus and dialogs, which teleport out of it, excepted)
 * ends it.
 */
const active = ref(false)
/**
 * "Somewhere else" is the whole composer, not just the editable area.
 *
 * A host wraps this in a box with its own controls — Attach, Cancel, the
 * Comment split button — and pressing one of those is still writing the
 * comment. `[data-kn-editor-shell]` marks that box; a press inside the shell
 * that owns *this* editor keeps the bar, while a press inside a sibling
 * composer's shell correctly ends it. Menus and dialogs teleport out of both,
 * so they are excused wholesale — only one can be open at a time.
 */
function onPointerDownOutside(event: PointerEvent) {
  const host = rootEl.value
  const target = event.target instanceof Element ? event.target : null
  if (!host || !target) return
  if (target.closest('[data-kn-editor-ui], [role="dialog"], [role="menu"], [data-reka-popper-content-wrapper]')) return
  const within = target.closest('.kn-editor, [data-kn-editor-shell]')
  if (within && (within === host || within.contains(host) || host.contains(within))) return
  active.value = false
}
const lowlight = createLowlight(common)

/** Guards the two-way binding: never re-parse markdown this component just produced. */
let lastEmitted = ''
/** The model half of the binding — see `createMarkdownSync`. */
let sync: MarkdownSync | null = null
/** Every stream this instance holds, closed with it. */
const subscriptions = new Subscription()
/**
 * The selection's formatting, for the one control here that shows it (the
 * link dialog). Read from the shared per-frame stream rather than from
 * `editor.isActive()` in the template, which would re-render this whole
 * component on every transaction.
 */
const format = shallowRef<FormatState>(EMPTY_FORMAT)

const { uploads, insertFiles, pickFiles } = useAttachments(
  async () => (props.resolveDocumentId ? props.resolveDocumentId() : null),
)

/* ---------------------------------------------------------------- menus */

/**
 * Pointer path for page references. The `@` suggestion plugin only fires on
 * *typed* input, so a toolbar button that inserted an "@" character produced a
 * stray "@" and no menu at all.
 */
const pagePickerOpen = ref(false)
const linkOpen = ref(false)
const linkUrl = ref('')

function openLinkDialog() {
  const instance = editor.value
  if (!instance) return
  linkUrl.value = (instance.getAttributes('link').href as string) ?? ''
  linkOpen.value = true
}

function insertMention(page: MentionablePage) {
  editor.value
    ?.chain()
    .focus()
    .insertDocMention({ documentId: page.documentId, label: page.title })
    .run()
}

const menuRef = ref<InstanceType<typeof CommandMenu> | null>(null)
const menu = ref<{
  kind: 'slash' | 'mention'
  query: string
  rect: { top: number; bottom: number; left: number } | null
  command: (payload: unknown) => void
} | null>(null)

const SLASH_ITEMS: (CommandItem & { run: (e: CoreEditor) => void })[] = [
  { id: 'h1', group: t('toolbar.group.text'), label: t('toolbar.heading1'), icon: Heading1, keywords: 'title', run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'h2', group: t('toolbar.group.text'), label: t('toolbar.heading2'), icon: Heading2, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'h3', group: t('toolbar.group.text'), label: t('toolbar.heading3'), icon: Heading3, run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet', group: t('toolbar.group.text'), label: t('toolbar.bulletList'), icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'ordered', group: t('toolbar.group.text'), label: t('toolbar.numberedList'), icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'task', group: t('toolbar.group.text'), label: t('toolbar.taskList'), icon: ListTodo, keywords: 'todo checkbox action', run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'quote', group: t('toolbar.group.text'), label: t('toolbar.quote'), icon: Quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', group: t('toolbar.group.text'), label: t('toolbar.codeBlock'), icon: Code, keywords: 'snippet syntax', run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: 'divider', group: t('toolbar.group.text'), label: t('toolbar.divider'), icon: Minus, keywords: 'hr rule separator', run: (e) => e.chain().focus().setHorizontalRule().run() },

  ...PANEL_TYPES.map((type) => ({
    id: `panel-${type}`,
    group: t('toolbar.group.panels'),
    label: t('panel.suffix', { label: t(PANEL_META[type].label) }),
    icon: Info,
    keywords: `callout admonition ${type}`,
    run: (e: CoreEditor) => e.chain().focus().toggledPanel(type as PanelType).run(),
  })),

  { id: 'table', group: t('toolbar.group.structure'), label: t('toolbar.table.label'), icon: Table2, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'expand', group: t('toolbar.group.structure'), label: t('toolbar.expand'), icon: Square, keywords: 'collapse details accordion', run: (e) => e.chain().focus().setExpand().run() },
  { id: 'layout2', group: t('toolbar.group.structure'), label: t('toolbar.twoColumns'), icon: Columns2, keywords: 'section layout', run: (e) => e.chain().focus().setLayout(2).run() },
  { id: 'layout3', group: t('toolbar.group.structure'), label: t('toolbar.threeColumns'), icon: Columns3, keywords: 'section layout', run: (e) => e.chain().focus().setLayout(3).run() },
  { id: 'toc', group: t('toolbar.group.structure'), label: t('toolbar.tableOfContents'), icon: Type, keywords: 'outline headings', run: (e) => e.chain().focus().setToc().run() },

  // Russian keywords are carried here because `menuItems` filters on
  // label + keywords + group: without them a Russian-locale author typing
  // `/энд` gets an empty menu.
  { id: 'api', group: t('toolbar.group.structure'), label: t('toolbar.apiContract'), icon: Route, keywords: 'endpoint http rest request response openapi swagger эндпоинт запрос', run: (e) => e.chain().focus().setApiContract().run() },
  { id: 'mermaid', group: t('toolbar.group.media'), label: t('toolbar.mermaid'), icon: Workflow, keywords: 'graph flowchart sequence', run: (e) => e.chain().focus().setMermaid().run() },
  { id: 'drawing', group: t('toolbar.group.media'), label: t('toolbar.whiteboard'), icon: PenLine, keywords: 'draw sketch excalidraw diagram', run: (e) => e.chain().focus().setDrawing().run() },
  { id: 'image', group: t('toolbar.group.media'), label: t('toolbar.image'), icon: ImageIcon, keywords: 'picture photo upload', run: (e) => pickFiles(e, 'image/*') },
  { id: 'file', group: t('toolbar.group.media'), label: t('toolbar.fileOrPdf'), icon: Paperclip, keywords: 'attachment document upload', run: (e) => pickFiles(e, '') },
  { id: 'mention', group: t('toolbar.group.media'), label: t('toolbar.linkToPage'), icon: FileText, keywords: 'reference mention doc', run: () => { pagePickerOpen.value = true } },
]

/** Blocks that belong in a page but not in a comment. */
const COMPACT_EXCLUDED = new Set(['layout2', 'layout3', 'toc', 'drawing', 'expand', 'api'])
const slashItems = computed(() =>
  props.compact ? SLASH_ITEMS.filter((i) => !COMPACT_EXCLUDED.has(i.id)) : SLASH_ITEMS,
)

const menuItems = computed<CommandItem[]>(() => {
  const state = menu.value
  if (!state) return []
  const query = state.query.trim().toLowerCase()
  if (state.kind === 'slash') {
    const items = slashItems.value
    if (!query) return items
    return items.filter((i) =>
      `${i.label} ${i.keywords ?? ''} ${i.group}`.toLowerCase().includes(query),
    )
  }
  // One sigil, two vocabularies. People first: `@` means a person everywhere
  // else, and a page can also be reached by `/` and by the toolbar, while a
  // person can only be reached here.
  const people = (query ? props.people.filter((p) => matches(query, p.name, p.hint)) : props.people)
    .slice(0, 6)
    .map((p): CommandItem => ({
      id: p.userId,
      kind: 'person',
      group: t('toolbar.group.people'),
      label: p.name,
      hint: p.hint,
      icon: AtSign,
    }))
  const pages = (query ? props.pages.filter((p) => matches(query, p.title, p.category)) : props.pages)
    .slice(0, 10)
    .map((p): CommandItem => ({
      id: p.documentId,
      kind: 'page',
      group: t('toolbar.group.pages'),
      label: p.title,
      hint: p.category,
      icon: FileText,
    }))
  const agents = (
    query ? props.agents.filter((a) => matches(query, a.name, a.description)) : props.agents
  )
    .slice(0, 6)
    .map((a): CommandItem => ({
      id: a.key,
      kind: 'agent',
      group: t('toolbar.group.agents'),
      label: a.name,
      hint: a.description,
      icon: Bot,
    }))
  return [...people, ...pages, ...agents]
})

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  return fields.some((f) => f?.toLowerCase().includes(query))
}

function pick(item: CommandItem) {
  menu.value?.command(item)
}

function suggestionHandlers(kind: 'slash' | 'mention') {
  return {
    onStart: (session: SuggestionSession) => open(kind, session),
    onUpdate: (session: SuggestionSession) => open(kind, session),
    onExit: () => {
      menu.value = null
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        menu.value = null
        return true
      }
      return menuRef.value?.onKeyDown(event) ?? false
    },
  }
}

function open(kind: 'slash' | 'mention', session: SuggestionSession) {
  menu.value = { kind, query: session.query, rect: session.rect, command: session.command }
}

const SlashCommand = createSuggestionExtension(
  {
    name: 'knSlash',
    char: '/',
    startOfLine: false,
    apply: ({ editor: e, range, payload }) => {
      const item = SLASH_ITEMS.find((i) => i.id === (payload as CommandItem)?.id)
      e.chain().focus().deleteRange(range).run()
      item?.run(e)
    },
  },
  suggestionHandlers('slash'),
)

const MentionCommand = createSuggestionExtension(
  {
    name: 'knMentionTrigger',
    char: '@',
    apply: ({ editor: e, range, payload }) => {
      const item = payload as CommandItem | undefined
      if (!item) return
      const chain = e.chain().focus().deleteRange(range)
      if (item.kind === 'person') chain.insertUserMention({ userId: item.id, label: item.label })
      else if (item.kind === 'agent') chain.insertAgentMention({ agentKey: item.id, label: item.label })
      else chain.insertDocMention({ documentId: item.id, label: item.label })
      chain.run()
    },
  },
  suggestionHandlers('mention'),
)

/* ------------------------------------------------------- drag handle */

const handle = ref<{ top: number; left: number; height: number } | null>(null)
const handlePos = ref<number | null>(null)
/**
 * The gutter lives in the margin outside the editable area, so moving the
 * pointer onto it leaves ProseMirror. Without this flag the handle hid itself
 * the instant you reached for it — the buttons were literally unclickable.
 */
const onHandle = ref(false)

/**
 * The handle's target, as the pointer reports it. Coalesced to one update per
 * frame: a fast sweep down a long page crosses many blocks between two paints,
 * and only the last one is ever seen.
 */
const handleMoves = new Subject<{ rect: { top: number; left: number; height: number } | null; pos: number | null }>()
subscriptions.add(
  handleMoves
    .pipe(
      auditTime(0, animationFrameScheduler),
      distinctUntilChanged((a, b) => a.pos === b.pos && shallowEqual(a.rect, b.rect)),
    )
    .subscribe(({ rect, pos }) => {
      handle.value = rect
      handlePos.value = pos
    }),
)

const DragHandleExtension = createDragHandle({
  onMove: (rect, pos) => handleMoves.next({ rect, pos }),
  isPointerOnHandle: () => onHandle.value,
})

/** Leaving the whole surface is the only thing that dismisses the gutter. */
function onSurfaceLeave(event: PointerEvent) {
  const next = event.relatedTarget as Node | null
  if (next && (event.currentTarget as HTMLElement).contains(next)) return
  if (blockMenuOpen.value) return
  onHandle.value = false
  handle.value = null
  handlePos.value = null
}

function onHandleDragStart(event: DragEvent) {
  const view = editor.value?.view
  if (!view || handlePos.value === null) return
  startBlockDrag(view, handlePos.value, event)
}

/**
 * The grip opens a menu; it does not delete. A click that silently removes the
 * block you were only trying to grab is the kind of trap that makes people stop
 * touching the gutter entirely.
 */
const blockMenuOpen = ref(false)
const gutterEl = ref<HTMLElement | null>(null)

// A popover has to be dismissible three ways or it reads as stuck: Escape,
// a click anywhere else, and simply carrying on typing.
onClickOutside(gutterEl, () => {
  blockMenuOpen.value = false
})
onKeyStroke('Escape', () => {
  if (!blockMenuOpen.value) return
  blockMenuOpen.value = false
  editor.value?.commands.focus()
})

function toggleBlockMenu() {
  const view = editor.value?.view
  if (!view || handlePos.value === null) return
  selectBlock(view, handlePos.value)
  blockMenuOpen.value = !blockMenuOpen.value
}

function runBlockAction(action: 'duplicate' | 'delete' | 'paragraph' | 1 | 2 | 3) {
  const instance = editor.value
  const view = instance?.view
  if (!instance || !view || handlePos.value === null) return
  const pos = handlePos.value
  blockMenuOpen.value = false
  if (action === 'duplicate') {
    duplicateBlock(view, pos)
    return
  }
  if (action === 'delete') {
    deleteBlock(view, pos)
    handle.value = null
    return
  }
  instance.chain().focus().setTextSelection(pos + 1).run()
  if (action === 'paragraph') instance.chain().focus().setParagraph().run()
  else instance.chain().focus().setNode('heading', { level: action }).run()
}

function onHandleInsert() {
  const instance = editor.value
  if (!instance || handlePos.value === null) return
  const node = instance.state.doc.nodeAt(handlePos.value)
  const at = handlePos.value + (node?.nodeSize ?? 0)
  instance.chain().focus().insertContentAt(at, { type: 'paragraph' }).setTextSelection(at + 1).insertContent('/').run()
}

/* ------------------------------------------------------------ editor */

function emitMarkdown(markdown: string) {
  lastEmitted = markdown
  emit('update:modelValue', markdown)
}

/**
 * Read surfaces resolve `[text](Exact Page Title)` to a link; the authoring
 * view deliberately does not.
 *
 * This component is both reader and editor since docs/features/15, and the
 * asymmetry is the point: what it parses is what `serialize` writes back, so
 * resolving a title while editing would rewrite the destination to
 * `/documents/<id>` on the next keystroke — a content change nobody asked for,
 * triggered by opening the page. An author sees the reference exactly as it is
 * stored, and can fix it deliberately.
 */
function toHtml(markdown: string): string {
  if (props.editable) return markdownToHtml(markdown)
  return markdownToHtml(markdown, { resolvePage: props.resolvePage })
}

onMounted(() => document.addEventListener('pointerdown', onPointerDownOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDownOutside))

onMounted(() => {
  const instance = new Editor({
    editable: props.editable,
    content: toHtml(props.modelValue),
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } },
        heading: { levels: [1, 2, 3, 4] },
      }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true, lastColumnResizable: false } }),
      Highlight,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === 'heading'
            ? t('editor.headingPlaceholder')
            : (props.placeholder as string) || t('editor.placeholder'),
      }),
      Panel,
      Expand,
      Layout,
      LayoutColumn,
      TableOfContents,
      // The block's section labels land in stored content, so it needs this
      // app's translator — same reason CommentAnchors takes one.
      ApiContract.configure({ t }),
      ApiSection,
      Mermaid,
      Drawing,
      FileEmbed,
      ResizableImage.configure({ inline: false, allowBase64: false }),
      StatusMark,
      DocMention,
      UserMention,
      AgentMention,
      SlashCommand,
      MentionCommand,
      DragHandleExtension,
      ListIndentKeymap.configure({ onLink: openLinkDialog }),
      // The extension builds aria-labels, so it needs this app's translator.
      CommentAnchors.configure({ t }),
      GlossaryTerms,
    ],
    editorProps: {
      attributes: { class: 'kn-prose', spellcheck: 'true' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])]
        if (files.length === 0) return false
        // Screenshot straight from the clipboard — the single most common way
        // a diagram gets into a page.
        event.preventDefault()
        void insertFiles(instance, files)
        return true
      },
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])]
        if (files.length === 0) return false
        event.preventDefault()
        void insertFiles(instance, files)
        return true
      },
    },
    onFocus: () => (active.value = true),
    onUpdate: () => {
      blockMenuOpen.value = false
    },
  })
  editor.value = instance
  lastEmitted = props.modelValue

  // Serializing walks the whole document, so it waits for a 200 ms pause in
  // typing: smooth on long pages, still immediate to a save (which flushes).
  sync = createMarkdownSync(instance, { dueTime: 200 })
  subscriptions.add(sync.markdown$.subscribe(emitMarkdown))
  subscriptions.add(editorStreams(instance).format$.subscribe((next) => (format.value = next)))

  syncCommentAnchors()
  syncGlossary()
  // One redraw when the roster and its exclusions land together — they are
  // usually one response — instead of a full-document decoration pass each.
  subscriptions.add(
    merge(
      fromWatch(() => props.glossaryTerms, { immediate: false }),
      fromWatch(() => props.glossaryExclusions, { immediate: false }),
      fromWatch(() => props.editable, { immediate: false }),
    )
      .pipe(auditTime(0))
      .subscribe(syncGlossary),
  )
  emit('ready')
})

/**
 * Redraw the highlights and report what no longer resolves. The outdated set is
 * only known after a pass, so it is read back from storage rather than computed
 * twice.
 */
function syncCommentAnchors() {
  const instance = editor.value
  if (!instance) return
  instance.commands.setCommentAnchors(props.commentAnchors)
  // The outdated set is written during the decoration pass, so it is read back
  // after the redraw has landed rather than in the same tick as the command.
  void nextTick(() => {
    if (editor.value === instance) emit('outdated-anchors', [...instance.storage.commentAnchors.outdated])
  })
}

watch(() => props.commentAnchors, syncCommentAnchors, { deep: true })

/**
 * The roster arrives after the first paint (it is a request) and changes when
 * someone edits the glossary, so the decorations are redrawn on both. Skipped
 * while editable for the reason the prop gives.
 */
function syncGlossary() {
  const instance = editor.value
  if (!instance) return
  instance.commands.setGlossaryTerms(
    props.editable ? [] : props.glossaryTerms,
    props.editable ? [] : props.glossaryExclusions,
  )
}

watch(
  () => props.modelValue,
  (next) => {
    const instance = editor.value
    if (!instance || next === lastEmitted) return
    // External change (loaded a document, AI appended a suggestion): re-parse.
    // An edit still waiting out its pause described the text being replaced.
    sync?.cancel()
    lastEmitted = next
    instance.commands.setContent(toHtml(next), { emitUpdate: false })
    syncCommentAnchors()
    syncGlossary()
  },
)

watch(
  () => props.editable,
  (editable) => editor.value?.setEditable(editable),
)

/**
 * The resolver usually lands after the first paint — its roster is a request —
 * and title references cannot resolve without it, so re-parse once it arrives.
 * Read view only, for the reason `toHtml` gives, which also makes this cheap:
 * it fires at most once per page, and never while anyone is typing.
 */
watch(
  () => props.resolvePage,
  () => {
    const instance = editor.value
    if (!instance || props.editable) return
    instance.commands.setContent(toHtml(props.modelValue), { emitUpdate: false })
    syncCommentAnchors()
    syncGlossary()
  },
)

onBeforeUnmount(() => {
  subscriptions.unsubscribe()
  sync?.dispose()
  editor.value?.destroy()
})

defineExpose({
  /** The live editor, for hosts that need to read the document (comment anchoring). */
  editor,
  /**
   * Flush any pending debounce, so a save never writes stale markdown. Always
   * serializes and emits, even with nothing pending, so the host's model is
   * the editor's normalised form of the page — what it would publish.
   */
  flush(): string {
    const instance = editor.value
    if (!instance || instance.isDestroyed) return props.modelValue
    sync?.cancel()
    const markdown = docToMarkdown(instance.state.doc, instance.schema)
    emitMarkdown(markdown)
    return markdown
  },
  focus() {
    editor.value?.commands.focus()
  },
  /**
   * Open the file picker and insert whatever comes back. Compact mode has no
   * toolbar, so the host supplies its own attach control and calls this.
   */
  attach(accept = '') {
    const instance = editor.value
    if (instance) void pickFiles(instance, accept)
  },
})
</script>

<template>
  <div
    ref="rootEl"
    class="kn-editor"
    :data-editable="editable"
    :data-compact="compact ? 'true' : undefined"
  >
    <EditorToolbar
      v-if="editor && editable && (!compact || active)"
      :editor="editor"
      :compact="compact"
      @pick-image="pickFiles(editor, 'image/*')"
      @pick-file="pickFiles(editor, '')"
      @link-page="pagePickerOpen = true"
      @link="openLinkDialog"
    />

    <div class="kn-editor-surface" @pointerleave="onSurfaceLeave">
      <!-- Gutter handle: drag to reorder, + to insert below, ✕ to remove. -->
      <div
        v-if="handle && editable"
        ref="gutterEl"
        class="kn-gutter"
        :style="{ top: `${handle.top}px`, left: `${handle.left}px` }"
        contenteditable="false"
        @pointerenter="onHandle = true"
        @pointerleave="onHandle = false"
      >
        <button type="button" class="kn-gutter-btn" :title="t('editor.insertBlockBelow')" @click="onHandleInsert">
          <Plus class="size-3.5" />
        </button>
        <button
          type="button"
          class="kn-gutter-btn kn-gutter-grip"
          draggable="true"
          :title="t('editor.dragToMove')"
          aria-haspopup="menu"
          :aria-expanded="blockMenuOpen"
          @dragstart="onHandleDragStart"
          @click="toggleBlockMenu"
        >
          <GripVertical class="size-3.5" />
        </button>

        <div v-if="blockMenuOpen" class="kn-block-menu" role="menu">
          <button type="button" role="menuitem" @click="runBlockAction('duplicate')">
            <CopyPlus class="size-3.5" /> {{ t('editor.duplicate') }}
          </button>
          <button type="button" role="menuitem" class="kn-danger" @click="runBlockAction('delete')">
            <Trash2 class="size-3.5" /> {{ t('common.delete') }}
          </button>
          <div class="kn-block-menu-label">{{ t('editor.turnInto') }}</div>
          <button type="button" role="menuitem" @click="runBlockAction('paragraph')">
            <Type class="size-3.5" /> {{ t('editor.text') }}
          </button>
          <button type="button" role="menuitem" @click="runBlockAction(1)">
            <Heading1 class="size-3.5" /> {{ t('toolbar.heading1') }}
          </button>
          <button type="button" role="menuitem" @click="runBlockAction(2)">
            <Heading2 class="size-3.5" /> {{ t('toolbar.heading2') }}
          </button>
          <button type="button" role="menuitem" @click="runBlockAction(3)">
            <Heading3 class="size-3.5" /> Heading 3
          </button>
        </div>
      </div>

      <div class="kn-editor-content">
        <!-- Page title and anything else that belongs above the prose, held to
             the same measure so the two read as one column. -->
        <div v-if="$slots.lede" class="kn-lede"><slot name="lede" /></div>
        <EditorContent v-if="editor" :editor="editor" />
      </div>

      <EditorBubble v-if="editor && editable" :editor="editor" @link="openLinkDialog" />
      <TableControls v-if="editor && editable && !compact" :editor="editor" />
    </div>

    <PagePickerDialog v-model:open="pagePickerOpen" :pages="pages" @pick="insertMention" />

    <LinkDialog
      v-if="editor"
      v-model:open="linkOpen"
      :initial-url="linkUrl"
      :has-link="format.link"
      @apply="editor.chain().focus().extendMarkRange('link').setLink({ href: $event }).run()"
      @remove="editor.chain().focus().extendMarkRange('link').unsetLink().run()"
    />

    <!--
      Teleported, and it has to be. The menu carries *viewport* coordinates in
      a `position: fixed` box, which only means the viewport while no ancestor
      establishes a containing block. In a comment composer one does: the
      annotation popover is `transform`ed + `will-change: transform`, so the
      menu was laid out against the popover instead — and then clipped away
      entirely by the composer's own `overflow-hidden`. Present in the DOM,
      correct content, invisible: typing `@` looked like it did nothing.
      (`EditorBubble` escapes this on its own — Floating UI subtracts the
      offset parent — but this menu positions itself.)
    -->
    <Teleport v-if="menu" to="body">
      <CommandMenu
        ref="menuRef"
        :items="menuItems"
        :rect="menu.rect"
        :empty-label="menu.kind === 'mention' ? t('editor.noMentionMatches') : t('editor.noBlockMatches')"
        @pick="pick"
      />
    </Teleport>

    <!-- Upload progress: inline, near the work, not a corner toast stack. -->
    <div v-if="uploads.length" class="kn-uploads" aria-live="polite">
      <div v-for="task in uploads" :key="task.id" class="kn-upload">
        <span class="kn-upload-name">{{ task.filename }}</span>
        <span class="kn-upload-track"
          ><span class="kn-upload-fill" :style="{ transform: `scaleX(${task.progress / 100})` }"
        /></span>
      </div>
    </div>
  </div>
</template>
