<script setup lang="ts">
// Review comment box: the page editor in compact mode, not a textarea.
//
// Comments carry the same markdown as pages — code spans, lists, links to
// other pages — so writing one should feel the same as writing one, rather
// than asking people to type markup blind and hope. RichEditor's model is
// markdown in and out, so the wire format is unchanged. Its formatting bar
// appears once the box is being written in (see `active` in RichEditor), so
// the controls are there without a toolbar sitting over every idle thread.
//
// Collapsed until it is wanted. Expanded, this is ~9rem of editor plus a
// button row; docked at the foot of a timeline that height would sit on top
// of the conversation permanently, so at rest it is a single line and the
// first click opens it. Both states are `bg-card` — on the page's own
// background an outlined box all but disappears.
//
// The same box also rewrites an existing comment: `initialBody` seeds it and
// `cancellable` gives the way back out, since an edit that cannot be
// abandoned is a trap.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ChevronDown, MessageSquare, MessagesSquare, Paperclip } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import RichEditor from '@/components/editor/RichEditor.vue'
import { useDocumentsStore } from '@/stores/documents'
import { useMembers } from './use-members'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    placeholder?: string
    busy?: boolean
    submitLabel?: string
    /** Skip the collapsed state — for boxes that only exist once opened. */
    autoExpand?: boolean
    /** Markdown to start from. Editing a comment; empty when writing a new one. */
    initialBody?: string
    /** Offer Cancel even when auto-expanded — an edit must be abandonable. */
    cancellable?: boolean
    /**
     * Offer GitLab's second action: Comment posts a remark, Start thread posts
     * a request that stays open until someone resolves it. Only for boxes that
     * begin a discussion — a reply inherits the shape of the one it lands in,
     * so replies get the plain button.
     */
    offerThread?: boolean
    /**
     * Document that uploads belong to. Attachments are stored per document
     * (see use-attachments), so without an owner there is nowhere to put a
     * file and the control is hidden rather than shown and broken.
     */
    resolveDocumentId?: () => Promise<string | null>
  }>(),
  {
    placeholder: 'Write a comment…',
    busy: false,
    submitLabel: 'Comment',
    autoExpand: false,
    initialBody: '',
    cancellable: false,
    offerThread: false,
    resolveDocumentId: undefined,
  },
)
/**
 * `resolvable` rides along with the body so a host that ignores it (a reply
 * box, an edit) keeps its one-argument handler working unchanged.
 */
const emit = defineEmits<{ submit: [body: string, resolvable: boolean]; cancel: [] }>()

/**
 * `@` names a teammate or a page, and the box sources both itself rather than
 * making five call sites pass them. A comment that says "ask @Ada about
 * @Token rotation" is the whole reason threads get read by the right person,
 * so the lists have to be there wherever a comment is written — not only in
 * the two places a host remembered to wire up.
 */
const { members } = useMembers()
const documents = useDocumentsStore()
onMounted(() => {
  if (!documents.loaded) void documents.fetchList()
})
const people = computed(() =>
  members.value
    .filter((m) => !m.disabled)
    .map((m) => ({ userId: m.userId, name: m.displayName, hint: m.email })),
)
const pages = computed(() =>
  documents.items.map((d) => ({ documentId: d.documentId, title: d.title, category: d.category })),
)

const body = ref(props.initialBody)
const open = ref(props.autoExpand)
const editorEl = ref<InstanceType<typeof RichEditor> | null>(null)

// Re-targeting the same box at another comment (two Edit buttons in one
// thread) has to reload it; RichEditor re-parses on an external model change.
watch(
  () => props.initialBody,
  (next) => (body.value = next),
)

/** Tiptap emits an empty paragraph as "", but a stray newline is just as empty. */
const isEmpty = () => body.value.replace(/\s/g, '') === ''

async function expand() {
  open.value = true
  await nextTick()
  editorEl.value?.focus()
}
// Hosts open this from outside — a Reply button beside a comment, say.
defineExpose({ expand })

function submit(resolvable = !props.offerThread) {
  // The editor debounces its markdown by 200ms, so submitting straight after
  // the last keystroke would post the text as it stood a moment ago. flush()
  // serializes now and returns what it wrote.
  const text = (editorEl.value?.flush() ?? body.value).trim()
  if (text.replace(/\s/g, '') === '') return
  emit('submit', text, resolvable)
  body.value = ''
  if (!props.autoExpand) open.value = false
}

function cancel() {
  body.value = props.initialBody
  if (!props.autoExpand) open.value = false
  emit('cancel')
}
</script>

<template>
  <button
    v-if="!open"
    type="button"
    class="flex w-full items-center rounded-md border bg-card px-3 py-2 text-left text-sm text-muted-foreground shadow-xs transition-colors hover:border-ring/60 hover:bg-accent/40 hover:text-foreground"
    @click="expand"
  >
    {{ placeholder }}
  </button>

  <form v-else data-kn-editor-shell class="space-y-2" @submit.prevent="submit()">
    <div
      class="overflow-hidden rounded-md border bg-card shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25"
    >
      <RichEditor
        ref="editorEl"
        v-model="body"
        compact
        :people="people"
        :pages="pages"
        :resolve-document-id="resolveDocumentId"
        :placeholder="`${placeholder} Press @ to mention, / for blocks.`"
      />
    </div>
    <div class="flex items-center gap-2">
      <Button
        v-if="resolveDocumentId"
        type="button"
        variant="ghost"
        size="sm"
        class="text-muted-foreground"
        :title="t('mr.attachFile')"
        @click="editorEl?.attach()"
      >
        <Paperclip class="size-3.5" />
      </Button>
      <Button
        v-if="!autoExpand || cancellable"
        type="button"
        variant="ghost"
        size="sm"
        class="ml-auto"
        @click="cancel"
      >
        {{ t('common.cancel') }}
      </Button>
      <!-- GitLab's split action. The primary is the everyday one — most
           remarks are remarks — and the one that opens an obligation is a
           deliberate second choice rather than the default. -->
      <div
        v-if="offerThread"
        class="flex items-center"
        :class="!autoExpand || cancellable ? '' : 'ml-auto'"
      >
        <Button type="submit" size="sm" class="rounded-r-none" :disabled="busy || isEmpty()">
          <MessageSquare class="size-3.5" />
          {{ submitLabel }}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              size="sm"
              class="rounded-l-none border-l border-primary-foreground/25 px-1.5"
              :disabled="busy || isEmpty()"
              :aria-label="t('mr.moreCommentActions')"
            >
              <ChevronDown class="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-64">
            <DropdownMenuItem class="items-start gap-2" @select="submit(false)">
              <MessageSquare class="mt-0.5 size-4 shrink-0" />
              <span>
                <span class="block font-medium">{{ submitLabel }}</span>
                <span class="block text-xs text-muted-foreground">{{ t('mr.plainRemark') }}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem class="items-start gap-2" @select="submit(true)">
              <MessagesSquare class="mt-0.5 size-4 shrink-0" />
              <span>
                <span class="block font-medium">{{ t('mr.startThread') }}</span>
                <span class="block text-xs text-muted-foreground">
                  {{ t('mr.staysOpen') }}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Button
        v-else
        type="submit"
        size="sm"
        :class="!autoExpand || cancellable ? '' : 'ml-auto'"
        :disabled="busy || isEmpty()"
      >
        {{ submitLabel }}
      </Button>
    </div>
  </form>
</template>
