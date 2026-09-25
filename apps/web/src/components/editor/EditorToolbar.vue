<script setup lang="ts">
/**
 * The persistent formatting bar. Confluence's shape: one row, grouped by what
 * the control does to the text, with the rarer inserts folded behind a single
 * "+" so the row does not become a wall of glyphs at narrow widths.
 */
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import type { Editor } from '@tiptap/core'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Check,
  ChevronDown,
  Code,
  Columns2,
  Columns3,
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
  Type,
  Underline as UnderlineIcon,
  Undo2,
  Workflow,
} from 'lucide-vue-next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PANEL_META, PANEL_TYPES, STATUS_COLORS, type PanelType, type StatusColor } from '@/lib/markdown/nodes'
import { useObservable } from '@/lib/rx-vue'
import { indent, outdent } from './extensions/list-indent'
import { editorStreams, readFormatState } from './editor-streams'

const { t } = useI18n()

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

const ALIGNMENTS = [
  { id: 'left', icon: AlignLeft, label: 'toolbar.left' },
  { id: 'center', icon: AlignCenter, label: 'toolbar.center' },
  { id: 'right', icon: AlignRight, label: 'toolbar.right' },
] as const
</script>

<template>
  <div class="kn-toolbar" :data-compact="compact ? 'true' : undefined" role="toolbar" :aria-label="t('toolbar.formatting')">
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
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.underline')"
        :aria-pressed="format.underline"
        @click="editor.chain().focus().toggleUnderline().run()"
      >
        <UnderlineIcon class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.strikethrough')"
        :aria-pressed="format.strike"
        @click="editor.chain().focus().toggleStrike().run()"
      >
        <Strikethrough class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.inlineCode')"
        :aria-pressed="format.code"
        @click="editor.chain().focus().toggleCode().run()"
      >
        <Code class="size-4" />
      </button>
    </div>

    <div class="kn-tb-group">
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.highlight')"
        :aria-pressed="format.highlight"
        @click="editor.chain().focus().toggleHighlight().run()"
      >
        <Highlighter class="size-4" />
      </button>
      <DropdownMenu v-if="!compact">
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
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.numberedList')"
        :aria-pressed="format.orderedList"
        @click="editor.chain().focus().toggleOrderedList().run()"
      >
        <ListOrdered class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.taskList')"
        :aria-pressed="format.taskList"
        @click="editor.chain().focus().toggleTaskList().run()"
      >
        <ListTodo class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.outdent')"
        :disabled="!format.canOutdent"
        @click="outdent(editor)"
      >
        <Outdent class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        :title="t('toolbar.indent')"
        :disabled="!format.canIndent"
        @click="indent(editor)"
      >
        <Indent class="size-4" />
      </button>
    </div>

    <div class="kn-tb-group">
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

    <DropdownMenu v-if="!compact">
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
