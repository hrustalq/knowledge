<script setup lang="ts">
// "Apply documents" widget for the composer: lets you manually ground a turn
// in one or more EXISTING workspace pages (distinct from the upload widget's
// ad hoc pasted files) — a lightweight select, not a full search UI, backed
// by the same GET /v1/documents list the sidebar tree already uses.
//
// Recently-applied documents are remembered client-side (localStorage) so
// the docs you keep coming back to surface at the top of the list on the
// next open, across threads and page reloads.
import { computed, nextTick, ref } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Check, FileText, FolderOpen } from 'lucide-vue-next'
import { useDocumentsStore } from '@/stores/documents'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { nativeEl } from '@/lib/utils'

export interface AppliedDocRef {
  documentId: string
  title: string
}

const selected = defineModel<AppliedDocRef[]>({ default: () => [] })

const RECENT_KEY = 'kn_assistant_recent_docs'
const MAX_RECENT = 8

const documents = useDocumentsStore()
const isOpen = ref(false)
const query = ref('')
const rootEl = ref<HTMLElement | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)
const setSearchEl = (c: unknown) => {
  searchEl.value = nativeEl<HTMLInputElement>(c)
}
const recent = ref<AppliedDocRef[]>(loadRecent())

function loadRecent(): AppliedDocRef[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (d): d is AppliedDocRef => typeof d?.documentId === 'string' && typeof d?.title === 'string',
    )
  } catch {
    return []
  }
}

function rememberRecent(doc: AppliedDocRef) {
  const next = [doc, ...recent.value.filter((d) => d.documentId !== doc.documentId)].slice(0, MAX_RECENT)
  recent.value = next
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable (private mode) — recall just won't persist */
  }
}

async function togglePanel() {
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    if (!documents.loaded) await documents.fetchList()
    query.value = ''
    void nextTick(() => searchEl.value?.focus())
  }
}

onClickOutside(rootEl, () => {
  isOpen.value = false
})

function isSelected(documentId: string): boolean {
  return selected.value.some((d) => d.documentId === documentId)
}

function toggleDoc(doc: AppliedDocRef) {
  if (isSelected(doc.documentId)) {
    selected.value = selected.value.filter((d) => d.documentId !== doc.documentId)
    return
  }
  selected.value = [...selected.value, doc]
  rememberRecent(doc)
}

// Recent items filtered/promoted to the top; the full list underneath,
// both narrowed by the same substring query (a plain select, not semantic
// search — good enough for browsing a workspace's page list by title).
const filteredRecent = computed(() => {
  const q = query.value.trim().toLowerCase()
  const known = new Set(documents.items.map((d) => d.documentId))
  return recent.value.filter((d) => known.has(d.documentId) && d.title.toLowerCase().includes(q))
})
const filteredAll = computed(() => {
  const q = query.value.trim().toLowerCase()
  const recentIds = new Set(filteredRecent.value.map((d) => d.documentId))
  return documents.items
    .filter((d) => !recentIds.has(d.documentId) && d.title.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title))
})
</script>

<template>
  <div ref="rootEl" class="relative">
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      :class="selected.length > 0 ? 'text-primary' : ''"
      aria-label="Apply documents"
      title="Apply documents"
      @click="togglePanel"
    >
      <FolderOpen class="size-4" />
    </Button>

    <div
      v-if="isOpen"
      class="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
    >
      <Input
        :ref="setSearchEl"
        v-model="query"
        type="text"
        placeholder="Search pages by title…"
        class="mb-2 h-8 text-sm"
      />

      <div class="max-h-64 overflow-y-auto">
        <p v-if="!documents.loaded" class="px-2 py-1.5 text-xs text-muted-foreground">Loading pages…</p>
        <template v-else>
          <p v-if="filteredRecent.length > 0" class="px-2 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground">Recent</p>
          <button
            v-for="d in filteredRecent"
            :key="d.documentId"
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
            @click="toggleDoc({ documentId: d.documentId, title: d.title })"
          >
            <FileText class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ d.title }}</span>
            <Check v-if="isSelected(d.documentId)" class="size-3.5 shrink-0 text-primary" />
          </button>

          <p v-if="filteredAll.length > 0" class="px-2 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground">All pages</p>
          <button
            v-for="d in filteredAll"
            :key="d.documentId"
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
            @click="toggleDoc({ documentId: d.documentId, title: d.title })"
          >
            <FileText class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ d.title }}</span>
            <Check v-if="isSelected(d.documentId)" class="size-3.5 shrink-0 text-primary" />
          </button>

          <p v-if="filteredRecent.length === 0 && filteredAll.length === 0" class="px-2 py-1.5 text-xs text-muted-foreground">
            No pages match "{{ query }}".
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
