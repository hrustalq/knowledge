<script setup lang="ts">
/**
 * The graph, given the whole screen.
 *
 * A rail widget is a 20rem column: enough to see that a page is connected, not
 * enough to see *how*. The generic maximize dialog was only a wider version of
 * the same problem — 64rem with the page still visible around it, so the graph
 * competed with the text it was about.
 *
 * This is the gallery gesture instead: the surroundings go away, the artefact
 * fills the frame, Escape brings the page back exactly as it was. It is built
 * on the same Dialog as everything else, so focus trapping, scroll locking and
 * the Escape key are the platform's rather than ours; only the frame is
 * different — a hairline header strip, because everything the frame spends on
 * itself is room the graph does not get.
 */
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

defineProps<{ open: boolean; title: string; subtitle?: string }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const { t } = useI18n()
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      hide-close
      class="grid h-[94vh] w-[97vw] max-w-none grid-rows-[auto_1fr] gap-0 overflow-hidden p-0"
    >
      <div class="flex min-w-0 items-center gap-3 border-b px-4 py-2.5">
        <div class="min-w-0 flex-1">
          <DialogTitle class="truncate font-display text-sm font-semibold">{{ title }}</DialogTitle>
          <DialogDescription class="sr-only">{{ subtitle || t('graph.lightboxHint') }}</DialogDescription>
        </div>
        <slot name="actions" />
        <kbd class="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground sm:inline-block">
          Esc
        </kbd>
        <DialogClose
          class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          :aria-label="t('common.close')"
        >
          <X class="size-4" />
        </DialogClose>
      </div>

      <div class="min-h-0 overflow-hidden"><slot /></div>
    </DialogContent>
  </Dialog>
</template>
