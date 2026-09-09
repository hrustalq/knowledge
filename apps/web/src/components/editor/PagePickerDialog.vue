<script setup lang="ts">
/**
 * "Link to a page" from the toolbar.
 *
 * A dialog rather than a fake `@` keystroke: the suggestion plugin only opens
 * on *typed* input, so programmatically inserting an "@" left a literal
 * character in the text and no menu — the toolbar button appeared to do
 * nothing. Typing `@` still opens the inline menu; this is the pointer path.
 */
import { useI18n } from 'vue-i18n'
import { labelFor } from '@/lib/labels'
import { computed, nextTick, ref, watch } from 'vue'
import { FileText } from 'lucide-vue-next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { MentionablePage } from './RichEditor.vue'

const { t } = useI18n()

const props = defineProps<{ open: boolean; pages: MentionablePage[] }>()
const emit = defineEmits<{ 'update:open': [boolean]; pick: [MentionablePage] }>()

const query = ref('')
const index = ref(0)
const inputEl = ref<InstanceType<typeof Input> | null>(null)

const matches = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const list = needle
    ? props.pages.filter((p) => p.title.toLowerCase().includes(needle))
    : props.pages
  return list.slice(0, 50)
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    index.value = 0
    void nextTick(() => {
      const el = (inputEl.value as unknown as { $el?: HTMLInputElement })?.$el
      el?.focus()
    })
  },
)
watch(matches, () => {
  index.value = 0
})

function choose(page?: MentionablePage) {
  const picked = page ?? matches.value[index.value]
  if (!picked) return
  emit('pick', picked)
  emit('update:open', false)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    index.value = Math.min(index.value + 1, matches.value.length - 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    index.value = Math.max(index.value - 1, 0)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    choose()
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Link to a page</DialogTitle>
        <DialogDescription>
          Inserts a reference chip. Typing <strong>@</strong> in the page does the same thing inline.
        </DialogDescription>
      </DialogHeader>

      <Input
        ref="inputEl"
        v-model="query"
        placeholder="Search pages…"
        autocomplete="off"
        @keydown="onKeydown"
      />

      <ul class="quiet-scroll max-h-72 overflow-y-auto" role="listbox" aria-label="Pages">
        <li v-for="(page, i) in matches" :key="page.documentId" role="option" :aria-selected="i === index">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
            :class="i === index ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'"
            @mouseenter="index = i"
            @click="choose(page)"
          >
            <FileText class="size-4 shrink-0 opacity-60" />
            <span class="truncate">{{ page.title }}</span>
            <span v-if="page.category" class="ml-auto shrink-0 text-xs text-muted-foreground">
              {{ labelFor(t, 'category', page.category) }}
            </span>
          </button>
        </li>
      </ul>
      <p v-if="matches.length === 0" class="py-4 text-center text-sm text-muted-foreground">
        No pages match “{{ query }}”.
      </p>
    </DialogContent>
  </Dialog>
</template>
