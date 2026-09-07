<script setup lang="ts">
/**
 * The persistent formatting bar. Confluence's shape: one row, grouped by what
 * the control does to the text, with the rarer inserts folded behind a single
 * "+" so the row does not become a wall of glyphs at narrow widths.
 */
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
import { canIndent, canOutdent, indent, outdent } from './extensions/list-indent'

const props = defineProps<{ editor: Editor }>()
const emit = defineEmits<{ pickImage: []; pickFile: []; linkPage: []; link: [] }>()

const TEXT_STYLES = [
  { id: 'paragraph', label: 'Normal text', level: 0 },
  { id: 'h1', label: 'Heading 1', level: 1 },
  { id: 'h2', label: 'Heading 2', level: 2 },
  { id: 'h3', label: 'Heading 3', level: 3 },
  { id: 'h4', label: 'Heading 4', level: 4 },
] as const

const currentStyle = computed(() => {
  for (const style of TEXT_STYLES) {
    if (style.level > 0 && props.editor.isActive('heading', { level: style.level })) return style
  }
  return TEXT_STYLES[0]
})

function setStyle(level: number) {
  const chain = props.editor.chain().focus()
  if (level === 0) chain.setParagraph().run()
  else chain.toggleHeading({ level: level as 1 | 2 | 3 | 4 }).run()
}

const ALIGNMENTS = [
  { id: 'left', icon: AlignLeft, label: 'Left' },
  { id: 'center', icon: AlignCenter, label: 'Center' },
  { id: 'right', icon: AlignRight, label: 'Right' },
] as const
</script>

<template>
  <div class="kn-toolbar" role="toolbar" aria-label="Formatting">
    <div class="kn-tb-group">
      <button
        type="button"
        class="kn-tb-btn"
        title="Undo (⌘Z)"
        :disabled="!editor.can().undo()"
        @click="editor.chain().focus().undo().run()"
      >
        <Undo2 class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        title="Redo (⇧⌘Z)"
        :disabled="!editor.can().redo()"
        @click="editor.chain().focus().redo().run()"
      >
        <Redo2 class="size-4" />
      </button>
    </div>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" class="kn-tb-select" title="Text style">
          <span>{{ currentStyle.label }}</span>
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
          <span :class="`kn-style-preview kn-style-${style.id}`">{{ style.label }}</span>
          <Check v-if="currentStyle.id === style.id" class="size-3.5 opacity-70" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <div class="kn-tb-group">
      <button
        type="button"
        class="kn-tb-btn"
        title="Bold (⌘B)"
        :aria-pressed="editor.isActive('bold')"
        @click="editor.chain().focus().toggleBold().run()"
      >
        <Bold class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        title="Italic (⌘I)"
        :aria-pressed="editor.isActive('italic')"
        @click="editor.chain().focus().toggleItalic().run()"
      >
        <Italic class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        title="Underline (⌘U)"
        :aria-pressed="editor.isActive('underline')"
        @click="editor.chain().focus().toggleUnderline().run()"
      >
        <UnderlineIcon class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        title="Strikethrough"
        :aria-pressed="editor.isActive('strike')"
        @click="editor.chain().focus().toggleStrike().run()"
      >
        <Strikethrough class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        title="Inline code (⌘E)"
        :aria-pressed="editor.isActive('code')"
        @click="editor.chain().focus().toggleCode().run()"
      >
        <Code class="size-4" />
      </button>
    </div>

    <div class="kn-tb-group">
      <button
        type="button"
        class="kn-tb-btn"
        title="Highlight"
        :aria-pressed="editor.isActive('highlight')"
        @click="editor.chain().focus().toggleHighlight().run()"
      >
        <Highlighter class="size-4" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" class="kn-tb-btn" title="Status lozenge">
            <span class="kn-tb-status-dot" />
            <ChevronDown class="size-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Status</DropdownMenuLabel>
          <DropdownMenuItem
            v-for="color in STATUS_COLORS"
            :key="color"
            @select="editor.chain().focus().toggleStatus(color as StatusColor).run()"
          >
            <span class="kn-status-sample" :data-kn-status="color">{{ color }}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="editor.chain().focus().unsetStatus().run()">Remove status</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div class="kn-tb-group">
      <button
        type="button"
        class="kn-tb-btn"
        title="Bullet list"
        :aria-pressed="editor.isActive('bulletList')"
        @click="editor.chain().focus().toggleBulletList().run()"
      >
        <List class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        title="Numbered list"
        :aria-pressed="editor.isActive('orderedList')"
        @click="editor.chain().focus().toggleOrderedList().run()"
      >
        <ListOrdered class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        title="Task list"
        :aria-pressed="editor.isActive('taskList')"
        @click="editor.chain().focus().toggleTaskList().run()"
      >
        <ListTodo class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        title="Outdent (⇧Tab)"
        :disabled="!canOutdent(editor)"
        @click="outdent(editor)"
      >
        <Outdent class="size-4" />
      </button>
      <button
        type="button"
        class="kn-tb-btn"
        title="Indent (Tab)"
        :disabled="!canIndent(editor)"
        @click="indent(editor)"
      >
        <Indent class="size-4" />
      </button>
    </div>

    <div class="kn-tb-group">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" class="kn-tb-btn" title="Alignment">
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
            <component :is="a.icon" class="size-4" /> {{ a.label }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        class="kn-tb-btn"
        title="Link (⌘K)"
        :aria-pressed="editor.isActive('link')"
        @click="emit('link')"
      >
        <Link2 class="size-4" />
      </button>
      <button type="button" class="kn-tb-btn" title="Link to a page (@)" @click="emit('linkPage')">
        <FileText class="size-4" />
      </button>
    </div>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" class="kn-tb-btn" title="Insert a panel">
          <Info class="size-4" />
          <ChevronDown class="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Panels</DropdownMenuLabel>
        <DropdownMenuItem
          v-for="type in PANEL_TYPES"
          :key="type"
          @select="editor.chain().focus().toggledPanel(type as PanelType).run()"
        >
          <span class="kn-panel-dot" :data-kn-panel="type" /> {{ PANEL_META[type].label }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" class="kn-tb-btn kn-tb-insert" title="Insert">
          <Plus class="size-4" />
          <ChevronDown class="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-60">
        <DropdownMenuLabel>Insert</DropdownMenuLabel>
        <DropdownMenuItem @select="editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()">
          <Table2 class="size-4" /> Table
        </DropdownMenuItem>
        <DropdownMenuItem @select="emit('pickImage')"><ImageIcon class="size-4" /> Image</DropdownMenuItem>
        <DropdownMenuItem @select="emit('pickFile')"><Paperclip class="size-4" /> File or PDF</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="editor.chain().focus().setMermaid().run()">
          <Workflow class="size-4" /> Mermaid diagram
        </DropdownMenuItem>
        <DropdownMenuItem @select="editor.chain().focus().setDrawing().run()">
          <PenLine class="size-4" /> Whiteboard
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="editor.chain().focus().setExpand().run()">
          <Square class="size-4" /> Expand
        </DropdownMenuItem>
        <DropdownMenuItem @select="editor.chain().focus().setLayout(2).run()">
          <Columns2 class="size-4" /> Two columns
        </DropdownMenuItem>
        <DropdownMenuItem @select="editor.chain().focus().setLayout(3).run()">
          <Columns3 class="size-4" /> Three columns
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="editor.chain().focus().toggleCodeBlock().run()">
          <Code class="size-4" /> Code block
        </DropdownMenuItem>
        <DropdownMenuItem @select="editor.chain().focus().toggleBlockquote().run()">
          <Quote class="size-4" /> Quote
        </DropdownMenuItem>
        <DropdownMenuItem @select="editor.chain().focus().setToc().run()">
          <Type class="size-4" /> Table of contents
        </DropdownMenuItem>
        <DropdownMenuItem @select="editor.chain().focus().setHorizontalRule().run()">
          <Minus class="size-4" /> Divider
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
