<script setup lang="ts">
// Review comment box: the page editor in compact mode, not a textarea.
//
// Comments carry the same markdown as pages — code spans, lists, links to
// other pages — so writing one should feel the same as writing one, rather
// than asking people to type markup blind and hope. RichEditor's model is
// markdown in and out, so the wire format is unchanged.
//
// Collapsed until it is wanted. Expanded, this is ~9rem of editor plus a
// button row; docked at the foot of a timeline that height would sit on top
// of the conversation permanently, so at rest it is a single line and the
// first click opens it. Both states are `bg-card` — on the page's own
// background an outlined box all but disappears.
import { nextTick, ref } from 'vue'
import { Paperclip } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import RichEditor from '@/components/editor/RichEditor.vue'

const props = withDefaults(
  defineProps<{
    placeholder?: string
    busy?: boolean
    submitLabel?: string
    /** Skip the collapsed state — for boxes that only exist once opened. */
    autoExpand?: boolean
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
    resolveDocumentId: undefined,
  },
)
const emit = defineEmits<{ submit: [body: string] }>()

const body = ref('')
const open = ref(props.autoExpand)
const editorEl = ref<InstanceType<typeof RichEditor> | null>(null)

/** Tiptap emits an empty paragraph as "", but a stray newline is just as empty. */
const isEmpty = () => body.value.replace(/\s/g, '') === ''

async function expand() {
  open.value = true
  await nextTick()
  editorEl.value?.focus()
}

function submit() {
  // The editor debounces its markdown by 200ms, so submitting straight after
  // the last keystroke would post the text as it stood a moment ago. flush()
  // serializes now and returns what it wrote.
  const text = (editorEl.value?.flush() ?? body.value).trim()
  if (text.replace(/\s/g, '') === '') return
  emit('submit', text)
  body.value = ''
  if (!props.autoExpand) open.value = false
}

function cancel() {
  body.value = ''
  open.value = false
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

  <form v-else class="space-y-2" @submit.prevent="submit">
    <div
      class="overflow-hidden rounded-md border bg-card shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25"
    >
      <RichEditor
        ref="editorEl"
        v-model="body"
        compact
        :resolve-document-id="resolveDocumentId"
        :placeholder="`${placeholder} Press / for blocks.`"
      />
    </div>
    <div class="flex items-center gap-2">
      <Button
        v-if="resolveDocumentId"
        type="button"
        variant="ghost"
        size="sm"
        class="text-muted-foreground"
        title="Attach an image, PDF or file"
        @click="editorEl?.attach()"
      >
        <Paperclip class="size-3.5" />
      </Button>
      <Button v-if="!autoExpand" type="button" variant="ghost" size="sm" class="ml-auto" @click="cancel">
        Cancel
      </Button>
      <Button type="submit" size="sm" :class="autoExpand ? 'ml-auto' : ''" :disabled="busy || isEmpty()">
        {{ submitLabel }}
      </Button>
    </div>
  </form>
</template>
