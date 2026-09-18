<script setup lang="ts">
/**
 * Feature 32: the pointer-free way to move a page.
 *
 * WCAG 2.2 §2.5.7 asks for a single-pointer alternative to any drag, and the
 * keyboard drag mode satisfies it — but only for people on a keyboard. This is
 * for the mouse user who cannot hold a drag steady, which is most of the people
 * the criterion was written for.
 *
 * It offers destinations, not positions. Ordering within a run is what dragging
 * and the arrow keys are for; a picker that also asked "before which sibling?"
 * would be two questions to answer a request that was only ever one.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Home, Search } from 'lucide-vue-next'
import type { DocumentTreeNode } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useDocumentsStore } from '@/stores/documents'

const props = defineProps<{ documentId: string; title: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ moved: []; failed: [message: string] }>()

const { t } = useI18n()
const store = useDocumentsStore()

const query = ref('')
const selected = ref<string | null>(null)
const submitting = ref(false)

/** Reset per opening: a remembered destination from last time is a trap. */
watch(open, (isOpen) => {
  if (!isOpen) return
  query.value = ''
  selected.value = null
})

interface Row {
  id: string
  title: string
  depth: number
}

/**
 * Every page that could hold this one — which is every page except itself and
 * its own descendants, since any page here can have children.
 */
const destinations = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (nodes: DocumentTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.documentId === props.documentId) continue
      out.push({ id: node.documentId, title: node.title, depth })
      walk(node.children, depth + 1)
    }
  }
  walk(store.tree, 0)
  return out
})

const filtered = computed(() => {
  const q = query.value.trim().toLocaleLowerCase()
  if (!q) return destinations.value
  return destinations.value.filter((r) => r.title.toLocaleLowerCase().includes(q))
})

const currentParent = computed(() => store.pathTo(props.documentId).at(-2)?.documentId ?? null)

async function submit() {
  submitting.value = true
  try {
    // Appended last in its new run: the picker never asked about order, so it
    // must not silently decide one that looks deliberate.
    await store.moveDocument(props.documentId, selected.value, null)
    open.value = false
    emit('moved')
  } catch (err) {
    emit('failed', err instanceof Error ? err.message : String(err))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[32rem] flex-col gap-0 p-0 sm:max-w-md">
      <DialogHeader class="px-5 pt-5 pb-3">
        <DialogTitle>{{ t('tree.dnd.moveTitle', { title }) }}</DialogTitle>
        <DialogDescription>{{ t('tree.dnd.moveDescription') }}</DialogDescription>
      </DialogHeader>

      <div class="border-border border-y px-5 py-2">
        <div class="relative">
          <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            v-model="query"
            class="h-8 pl-7"
            :placeholder="t('tree.dnd.moveSearch')"
            :aria-label="t('tree.dnd.moveSearch')"
          />
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <!-- The root is a destination like any other, and the first one listed:
             re-rooting a page is otherwise the one move with nowhere to click. -->
        <button
          type="button"
          class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors"
          :class="selected === null ? 'bg-primary/10 text-primary' : ''"
          @click="selected = null"
        >
          <Home class="size-3.5 shrink-0" />
          <span class="truncate">{{ t('tree.dnd.topLevel') }}</span>
          <span v-if="currentParent === null" class="text-muted-foreground ml-auto shrink-0 text-xs">
            {{ t('tree.dnd.current') }}
          </span>
        </button>

        <button
          v-for="row in filtered"
          :key="row.id"
          type="button"
          class="hover:bg-accent flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors"
          :class="selected === row.id ? 'bg-primary/10 text-primary' : ''"
          :style="{ paddingLeft: `${row.depth * 14 + 8}px` }"
          @click="selected = row.id"
        >
          <ChevronRight class="text-muted-foreground/60 size-3 shrink-0" />
          <span class="truncate">{{ row.title }}</span>
          <span v-if="currentParent === row.id" class="text-muted-foreground ml-auto shrink-0 text-xs">
            {{ t('tree.dnd.current') }}
          </span>
        </button>

        <p v-if="!filtered.length" class="text-muted-foreground px-2 py-6 text-center text-sm">
          {{ t('tree.dnd.moveNoMatch') }}
        </p>
      </div>

      <DialogFooter class="border-border border-t px-5 py-3">
        <Button variant="ghost" :disabled="submitting" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button :disabled="submitting || selected === currentParent" @click="submit">
          {{ t('tree.dnd.moveConfirm') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
