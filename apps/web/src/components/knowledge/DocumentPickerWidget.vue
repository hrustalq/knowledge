<script setup lang="ts">
// "Apply documents" widget for the composer: lets you ground a turn in one or
// more EXISTING workspace pages (distinct from the upload widget's ad hoc
// pasted files) — a lightweight select, not a full search UI, backed by the
// same GET /v1/documents list the sidebar tree already uses.
//
// Recently-applied documents are remembered client-side (localStorage) so the
// docs you keep coming back to surface at the top of the list on the next
// open, across threads and page reloads.
//
// The panel is a ResponsivePopover: portalled and collision-aware on desktop
// (it used to be an `absolute` box, which the chat page's `overflow-hidden`
// cropped and a narrow viewport pushed off-screen), and a bottom sheet on a
// phone, where a 288px panel hung off a toolbar button has nowhere to go.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, watch } from 'vue'
import { Check, FileText, FolderOpen } from 'lucide-vue-next'
import { useDocumentsStore } from '@/stores/documents'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsivePopover } from '@/components/ui/popover'

const { t } = useI18n()

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

// Opening is what loads the list, so the composer costs nothing until asked.
watch(isOpen, (open) => {
  if (!open) return
  query.value = ''
  if (!documents.loaded) void documents.fetchList()
  void nextTick()
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
  <ResponsivePopover
    v-model:open="isOpen"
    :title="t('picker.applyDocuments')"
    :description="t('chat.groundInPages')"
    panel-class="w-80 p-2"
  >
    <template #trigger>
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        :class="selected.length > 0 ? 'text-primary' : ''"
        :aria-label="t('picker.applyDocuments')"
        :title="t('picker.applyDocuments')"
      >
        <FolderOpen class="size-4" />
      </Button>
    </template>

    <template #default="{ compact }">
      <Input
        v-model="query"
        type="text"
        :autofocus="!compact"
        :placeholder="t('picker.searchByTitle')"
        class="mb-2 h-8 text-sm"
      />

      <!-- On the sheet the surface already scrolls, so a second capped
           scroller here would trap the list in a box inside a box. -->
      <div :class="compact ? '' : 'max-h-64 overflow-y-auto'">
        <p v-if="!documents.loaded" class="text-muted-foreground px-2 py-1.5 text-xs">{{ t('picker.loadingPages') }}</p>
        <template v-else>
          <p v-if="filteredRecent.length > 0" class="text-muted-foreground px-2 pt-1 pb-0.5 text-[11px] font-medium">
            {{ t('chat.recent') }}
          </p>
          <button
            v-for="d in filteredRecent"
            :key="d.documentId"
            type="button"
            class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors sm:py-1.5"
            @click="toggleDoc({ documentId: d.documentId, title: d.title })"
          >
            <FileText class="text-muted-foreground size-3.5 shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ d.title }}</span>
            <Check v-if="isSelected(d.documentId)" class="text-primary size-3.5 shrink-0" />
          </button>

          <p v-if="filteredAll.length > 0" class="text-muted-foreground px-2 pt-2 pb-0.5 text-[11px] font-medium">
            {{ t('chat.allPages') }}
          </p>
          <button
            v-for="d in filteredAll"
            :key="d.documentId"
            type="button"
            class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors sm:py-1.5"
            @click="toggleDoc({ documentId: d.documentId, title: d.title })"
          >
            <FileText class="text-muted-foreground size-3.5 shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ d.title }}</span>
            <Check v-if="isSelected(d.documentId)" class="text-primary size-3.5 shrink-0" />
          </button>

          <p
            v-if="filteredRecent.length === 0 && filteredAll.length === 0"
            class="text-muted-foreground px-2 py-1.5 text-xs"
          >
            No pages match “{{ query }}”.
          </p>
        </template>
      </div>
    </template>
  </ResponsivePopover>
</template>
