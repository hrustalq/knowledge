<script setup lang="ts">
/**
 * The persistent formatting bar. Confluence's shape: one row, grouped by what
 * the control does to the text, with the rarer inserts folded behind a single
 * "+" so the row does not become a wall of glyphs at narrow widths.
 *
 * Narrower still, the row sheds whole groups into a "More" menu rather than
 * scrolling sideways — a toolbar you have to scroll to find Bold in is a broken
 * one. It measures itself, not the viewport: the assistant panel narrows the
 * editor on a wide screen just as a phone does, and the dropdown is teleported
 * out of reach of any container query, so the tier is a number both halves read.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useElementSize, useMediaQuery } from '@vueuse/core'
import type { Editor } from '@tiptap/core'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Bold,
  Check,
  ChevronDown,
  Code,
  Columns2,
  Columns3,
  CopyPlus,
  FileText,
  Highlighter,
  Image as ImageIcon,
  Indent,
  Info,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  MoreHorizontal,
  Outdent,
  Paperclip,
  PenLine,
  Plus,
  Quote,
  Redo2,
  Route,
  Square,
  Strikethrough,
  Table2,
  Trash2,
  Type,
  Underline as UnderlineIcon,
  Undo2,
  Workflow,
  Boxes,
} from 'lucide-vue-next'
import { starterModel } from '@/core/markdown/structurizr-edit'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@knowledge/ui/dropdown-menu'
import { PANEL_META, PANEL_TYPES, STATUS_COLORS, type PanelType, type StatusColor } from '@/core/markdown/nodes'
import { useObservable } from '@/shared/composables/rx-vue'
import { indent, outdent } from './extensions/list-indent'
import { deleteBlock, duplicateBlock, moveBlock, selectedBlockPos } from './extensions/drag-handle'
import { editorStreams, readFormatState } from '../model/editor-streams'

const { t } = useI18n()
/** A person using a system, in the reader's language: a C4 block that draws from the start. */
const c4Starter = () => starterModel({ user: t('c4.starter.user'), system: t('c4.starter.system'), uses: t('c4.starter.uses') })

const props = withDefaults(
  defineProps<{
    editor: Editor
    /**
     * Comment-box variant: the same bar with the page furniture dropped.
     * Alignment, panels, status lozenges, columns, expands and a table of
     * contents are page decisions — in a two-sentence reply they are noise in
     * a row that has to survive a 300px rail.
     */
    compact?: boolean
  }>(),
  { compact: false },
)
const emit = defineEmits<{ pickImage: []; pickFile: []; linkPage: []; link: [] }>()

const TEXT_STYLES = [
  { id: 'paragraph', label: 'toolbar.normalText', level: 0 },
  { id: 'h1', label: 'toolbar.heading1', level: 1 },
  { id: 'h2', label: 'toolbar.heading2', level: 2 },
  { id: 'h3', label: 'toolbar.heading3', level: 3 },
  { id: 'h4', label: 'toolbar.heading4', level: 4 },
] as const

/**
 * The bar's state, from the editor's shared per-frame stream. The template
 * used to ask `editor.isActive()` directly, and because `@tiptap/vue-3` makes
 * the editor state reactive, that re-rendered the whole bar on every
 * transaction — each keystroke — to find the answers mostly unchanged.
 */
const format = useObservable(editorStreams(props.editor).format$, readFormatState(props.editor))

const currentStyle = computed(
  () => TEXT_STYLES.find((style) => style.level === format.value.heading) ?? TEXT_STYLES[0],
)

function setStyle(level: number) {
  const chain = props.editor.chain().focus()
  if (level === 0) chain.setParagraph().run()
  else chain.toggleHeading({ level: level as 1 | 2 | 3 | 4 }).run()
}

/**
 * How much of the row folds into "More". 0: nothing. 1: the page furniture —
 * status, indent, alignment, links, panels. 2: the secondary marks and lists
 * too, leaving undo, text style, bold, italic, bullets and insert: what a
 * paragraph written on a phone actually needs. Thresholds are the widths at
 * which the row stopped fitting, measured with the Russian labels, which run
 * longest.
 */
const bar = ref<HTMLElement | null>(null)
const { width } = useElementSize(bar)
const tier = computed(() => {
  // 0 before the first measurement (and during SSR): the full row, as before.
  if (width.value === 0) return 0
  if (width.value < (props.compact ? 300 : 480)) return 2
  if (width.value < (props.compact ? 0 : 760)) return 1
  return 0
})

/**
 * #1063: the gutter handle is a hover affordance, and touch has no hover — it
 * rendered off-screen and its HTML5 drag never starts from a finger. On touch
 * the block actions live in "More" instead, acting on the block holding the
 * caret. Page editor only: the comment box has no gutter to stand in for.
 */
const touch = useMediaQuery('(hover: none)')
const blockActions = computed(() => touch.value && !props.compact)

type BlockAction = 'up' | 'down' | 'duplicate' | 'delete'

/**
 * A block action redraws the moved block, and run from inside the open menu it
 * redraws it while focus is in the menu: ProseMirror cannot place the DOM
 * selection then, reads back a stale one on the next tap, and the caret leaps
 * to the end of the page. So the item only records the action; it runs once
 * the menu has closed, in the editor rather than back on the More button.
 */
let pendingBlock: BlockAction | null = null
function pickBlock(action: BlockAction) {
  pendingBlock = action
}

function onMoreClosed(event: Event) {
  const action = pendingBlock
  pendingBlock = null
  if (!action) return
  event.preventDefault()
  props.editor.commands.focus()
  const { view, state } = props.editor
  const pos = selectedBlockPos(state)
  if (pos === null) return
  if (action === 'up') moveBlock(view, pos, -1)
  else if (action === 'down') moveBlock(view, pos, 1)
  else if (action === 'duplicate') duplicateBlock(view, pos)
  else deleteBlock(view, pos)
}

const ALIGNMENTS = [
  { id: 'left', icon: AlignLeft, label: 'toolbar.left' },
  { id: 'center', icon: AlignCenter, label: 'toolbar.center' },
  { id: 'right', icon: AlignRight, label: 'toolbar.right' },
] as const
</script>

<template>
  <div
    ref="bar"
    class="kn-toolbar"
    :class="{ 'kn-scroll-strip': tier === 2 }"
    :data-compact="compact ? 'true' : undefined"
    :data-tier="tier"
    role="toolbar"
    :aria-label="t('toolbar.formatting')"
  >
    <div class="kn-tb-group">
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.undo')"
        :disabled="!format.canUndo"
        @click="editor.chain().focus().undo().run()"
      >
        <Undo2 class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.redo')"
        :disabled="!format.canRedo"
        @click="editor.chain().focus().redo().run()"
      >
        <Redo2 class="size-4" />
      </button>
    </div>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" class="kn-tb-select" :title="t('toolbar.textStyle')">
          <span>{{ t(currentStyle.label) }}</span>
          <ChevronDown class="size-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-52">
        <DropdownMenuItem
          v-for="style in TEXT_STYLES"
          :key="style.id"
          class="justify-between"
          @select="setStyle(style.level)"
        >
          <span :class="`kn-style-preview kn-style-${style.id}`">{{ t(style.label) }}</span>
          <Check v-if="currentStyle.id === style.id" class="size-3.5 opacity-70" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <div class="kn-tb-group">
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.bold')"
        :aria-pressed="format.bold"
        @click="editor.chain().focus().toggleBold().run()"
      >
        <Bold class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.italic')"
        :aria-pressed="format.italic"
        @click="editor.chain().focus().toggleItalic().run()"
      >
        <Italic class="size-4" />
      </button>
      <button
        v-if="tier < 2"
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.underline')"
        :aria-pressed="format.underline"
        @click="editor.chain().focus().toggleUnderline().run()"
      >
        <UnderlineIcon class="size-4" />
      </button>
      <button
        v-if="tier < 2"
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.strikethrough')"
        :aria-pressed="format.strike"
        @click="editor.chain().focus().toggleStrike().run()"
      >
        <Strikethrough class="size-4" />
      </button>
      <button
        v-if="tier < 2"
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.inlineCode')"
        :aria-pressed="format.code"
        @click="editor.chain().focus().toggleCode().run()"
      >
        <Code class="size-4" />
      </button>
    </div>

    <div v-if="tier < 2" class="kn-tb-group">
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.highlight')"
        :aria-pressed="format.highlight"
        @click="editor.chain().focus().toggleHighlight().run()"
      >
        <Highlighter class="size-4" />
      </button>
      <DropdownMenu v-if="!compact && tier < 1">
        <DropdownMenuTrigger as-child>
          <button type="button" class="kn-tb-btn" :title="t('toolbar.statusLozenge')">
            <span class="kn-tb-status-dot" />
            <ChevronDown class="size-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{{ t('toolbar.status') }}</DropdownMenuLabel>
          <DropdownMenuItem
            v-for="color in STATUS_COLORS"
            :key="color"
            @select="editor.chain().focus().toggleStatus(color as StatusColor).run()"
          >
            <span class="kn-status-sample" :data-kn-status="color">{{ color }}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="editor.chain().focus().unsetStatus().run()">{{ t('toolbar.removeStatus') }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div class="kn-tb-group">
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.bulletList')"
        :aria-pressed="format.bulletList"
        @click="editor.chain().focus().toggleBulletList().run()"
      >
        <List class="size-4" />
      </button>
      <button
        v-if="tier < 2"
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.numberedList')"
        :aria-pressed="format.orderedList"
        @click="editor.chain().focus().toggleOrderedList().run()"
      >
        <ListOrdered class="size-4" />
      </button>
      <button
        v-if="tier < 2"
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.taskList')"
        :aria-pressed="format.taskList"
        @click="editor.chain().focus().toggleTaskList().run()"
      >
        <ListTodo class="size-4" />
      </button>
      <button
        v-if="tier < 1"
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.outdent')"
        :disabled="!format.canOutdent"
        @click="outdent(editor)"
      >
        <Outdent class="size-4" />
      </button>
      <button
        v-if="tier < 1"
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.indent')"
        :disabled="!format.canIndent"
        @click="indent(editor)"
      >
        <Indent class="size-4" />
      </button>
    </div>

    <div v-if="tier < 1" class="kn-tb-group">
      <DropdownMenu v-if="!compact">
        <DropdownMenuTrigger as-child>
          <button type="button" class="kn-tb-btn" :title="t('toolbar.alignment')">
            <AlignLeft class="size-4" />
            <ChevronDown class="size-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            v-for="a in ALIGNMENTS"
            :key="a.id"
            @select="editor.chain().focus().setTextAlign(a.id).run()"
          >
            <component :is="a.icon" class="size-4" /> {{ t(a.label) }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.link')"
        :aria-pressed="format.link"
        @click="emit('link')"
      >
        <Link2 class="size-4" />
      </button>
      <button type="button" class="kn-tb-btn" :title="t('toolbar.linkToPageHint')" @click="emit('linkPage')">
        <FileText class="size-4" />
      </button>
    </div>

    <DropdownMenu v-if="!compact && tier < 1">
      <DropdownMenuTrigger as-child>
        <button type="button" class="kn-tb-btn" :title="t('toolbar.insertPanel')">
          <Info class="size-4" />
          <ChevronDown class="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{{ t('toolbar.panels') }}</DropdownMenuLabel>
        <DropdownMenuItem
          v-for="type in PANEL_TYPES"
          :key="type"
          @select="editor.chain().focus().toggledPanel(type as PanelType).run()"
        >
          <span class="kn-panel-dot" :data-kn-panel="type" /> {{ t(PANEL_META[type].label) }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- Whatever the row had no room for, in the row's own order; on touch,
         the block actions too (#1063). -->
    <DropdownMenu v-if="tier > 0 || blockActions">
      <DropdownMenuTrigger as-child>
        <button type="button" class="kn-tb-btn" :title="t('toolbar.more')" :aria-label="t('toolbar.more')">
          <MoreHorizontal class="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-56" @close-auto-focus="onMoreClosed">
        <template v-if="tier > 0">
          <template v-if="tier > 1">
            <DropdownMenuItem @select="editor.chain().focus().toggleUnderline().run()">
              <UnderlineIcon class="size-4" /> {{ t('toolbar.underline') }}
              <Check v-if="format.underline" class="ml-auto size-3.5 opacity-70" />
            </DropdownMenuItem>
            <DropdownMenuItem @select="editor.chain().focus().toggleStrike().run()">
              <Strikethrough class="size-4" /> {{ t('toolbar.strikethrough') }}
              <Check v-if="format.strike" class="ml-auto size-3.5 opacity-70" />
            </DropdownMenuItem>
            <DropdownMenuItem @select="editor.chain().focus().toggleCode().run()">
              <Code class="size-4" /> {{ t('toolbar.inlineCode') }}
              <Check v-if="format.code" class="ml-auto size-3.5 opacity-70" />
            </DropdownMenuItem>
            <DropdownMenuItem @select="editor.chain().focus().toggleHighlight().run()">
              <Highlighter class="size-4" /> {{ t('toolbar.highlight') }}
              <Check v-if="format.highlight" class="ml-auto size-3.5 opacity-70" />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="editor.chain().focus().toggleOrderedList().run()">
              <ListOrdered class="size-4" /> {{ t('toolbar.numberedList') }}
              <Check v-if="format.orderedList" class="ml-auto size-3.5 opacity-70" />
            </DropdownMenuItem>
            <DropdownMenuItem @select="editor.chain().focus().toggleTaskList().run()">
              <ListTodo class="size-4" /> {{ t('toolbar.taskList') }}
              <Check v-if="format.taskList" class="ml-auto size-3.5 opacity-70" />
            </DropdownMenuItem>
          </template>
          <DropdownMenuItem :disabled="!format.canOutdent" @select="outdent(editor)">
            <Outdent class="size-4" /> {{ t('toolbar.outdent') }}
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="!format.canIndent" @select="indent(editor)">
            <Indent class="size-4" /> {{ t('toolbar.indent') }}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="emit('link')">
            <Link2 class="size-4" /> {{ t('toolbar.link') }}
            <Check v-if="format.link" class="ml-auto size-3.5 opacity-70" />
          </DropdownMenuItem>
          <DropdownMenuItem @select="emit('linkPage')">
            <FileText class="size-4" /> {{ t('toolbar.linkToPageHint') }}
          </DropdownMenuItem>
          <template v-if="!compact">
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><AlignLeft class="size-4" /> {{ t('toolbar.alignment') }}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  v-for="a in ALIGNMENTS"
                  :key="a.id"
                  @select="editor.chain().focus().setTextAlign(a.id).run()"
                >
                  <component :is="a.icon" class="size-4" /> {{ t(a.label) }}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span class="kn-tb-status-dot" /> {{ t('toolbar.statusLozenge') }}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  v-for="color in STATUS_COLORS"
                  :key="color"
                  @select="editor.chain().focus().toggleStatus(color as StatusColor).run()"
                >
                  <span class="kn-status-sample" :data-kn-status="color">{{ color }}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem @select="editor.chain().focus().unsetStatus().run()">
                  {{ t('toolbar.removeStatus') }}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Info class="size-4" /> {{ t('toolbar.insertPanel') }}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  v-for="type in PANEL_TYPES"
                  :key="type"
                  @select="editor.chain().focus().toggledPanel(type as PanelType).run()"
                >
                  <span class="kn-panel-dot" :data-kn-panel="type" /> {{ t(PANEL_META[type].label) }}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </template>
        </template>
        <template v-if="blockActions">
          <DropdownMenuSeparator v-if="tier > 0" />
          <DropdownMenuLabel>{{ t('toolbar.block') }}</DropdownMenuLabel>
          <DropdownMenuItem :disabled="!format.canMoveUp" @select="pickBlock('up')">
            <ArrowUp class="size-4" /> {{ t('toolbar.moveBlockUp') }}
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="!format.canMoveDown" @select="pickBlock('down')">
            <ArrowDown class="size-4" /> {{ t('toolbar.moveBlockDown') }}
          </DropdownMenuItem>
          <DropdownMenuItem @select="pickBlock('duplicate')">
            <CopyPlus class="size-4" /> {{ t('toolbar.duplicateBlock') }}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" @select="pickBlock('delete')">
            <Trash2 class="size-4" /> {{ t('toolbar.deleteBlock') }}
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" class="kn-tb-btn kn-tb-insert" :title="t('toolbar.insert')">
          <Plus class="size-4" />
          <ChevronDown class="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-60">
        <DropdownMenuLabel>{{ t('toolbar.insert') }}</DropdownMenuLabel>
        <DropdownMenuItem @select="editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()">
          <Table2 class="size-4" /> {{ t('toolbar.table.label') }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="emit('pickImage')"><ImageIcon class="size-4" /> {{ t('toolbar.image') }}</DropdownMenuItem>
        <DropdownMenuItem @select="emit('pickFile')"><Paperclip class="size-4" /> {{ t('toolbar.fileOrPdf') }}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="editor.chain().focus().setMermaid().run()">
          <Workflow class="size-4" /> {{ t('toolbar.mermaid') }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="editor.chain().focus().setC4(c4Starter()).run()">
          <Boxes class="size-4" /> {{ t('toolbar.c4') }}
        </DropdownMenuItem>
        <DropdownMenuItem v-if="!compact" @select="editor.chain().focus().setDrawing().run()">
          <PenLine class="size-4" /> {{ t('toolbar.whiteboard') }}
        </DropdownMenuItem>
        <template v-if="!compact">
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="editor.chain().focus().setExpand().run()">
            <Square class="size-4" /> {{ t('toolbar.expand') }}
          </DropdownMenuItem>
          <DropdownMenuItem @select="editor.chain().focus().setLayout(2).run()">
            <Columns2 class="size-4" /> {{ t('toolbar.twoColumns') }}
          </DropdownMenuItem>
          <DropdownMenuItem @select="editor.chain().focus().setLayout(3).run()">
            <Columns3 class="size-4" /> {{ t('toolbar.threeColumns') }}
          </DropdownMenuItem>
        </template>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="editor.chain().focus().toggleCodeBlock().run()">
          <Code class="size-4" /> {{ t('toolbar.codeBlock') }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="editor.chain().focus().toggleBlockquote().run()">
          <Quote class="size-4" /> {{ t('toolbar.quote') }}
        </DropdownMenuItem>
        <DropdownMenuItem v-if="!compact" @select="editor.chain().focus().setToc().run()">
          <Type class="size-4" /> {{ t('toolbar.tableOfContents') }}
        </DropdownMenuItem>
        <DropdownMenuItem v-if="!compact" @select="editor.chain().focus().setApiContract().run()">
          <Route class="size-4" /> {{ t('toolbar.apiContract') }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="editor.chain().focus().setHorizontalRule().run()">
          <Minus class="size-4" /> {{ t('toolbar.divider') }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
