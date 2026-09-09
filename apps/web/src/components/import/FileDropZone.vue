<script setup lang="ts">
/**
 * The drop target.
 *
 * A real `<button>` wrapping a hidden `<input type=file>`, not a div with a
 * click handler: drag-and-drop is the fast path but it is not the only one, and
 * a target you cannot reach with a keyboard is not a target. It fills its
 * column rather than sitting as a band — this is the one element on the step
 * that genuinely wants area, and a bigger target is a better one.
 *
 * Both refusals — wrong type, too big — are made here, before a single byte
 * moves, and both name the thing that was wrong rather than saying "invalid
 * file".
 *
 * MOTION. Two moments, both feedback rather than decoration: the zone answers
 * a file being carried over it (you are holding something it will take), and
 * the chosen file arrives rather than replacing the invitation instantly, so
 * you can see that what you dropped is what it got.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { FileUp, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { ACCEPT_ATTR, PARSER_ICONS, formatBytes, inspectFile } from './formats'
import { IMPORT_FORMATS } from '@knowledge/contracts'

const { t } = useI18n()

const props = defineProps<{ modelValue: File | null; maxBytes: number; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [File | null] }>()

const input = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const rejection = ref<string | null>(null)

const verdict = computed(() => (props.modelValue ? inspectFile(props.modelValue, props.maxBytes) : null))
const Icon = computed(() => (verdict.value?.parser ? PARSER_ICONS[verdict.value.parser] : FileUp))

/** "PDF · Word · PowerPoint…" — the offer, in the product's own words. */
const offered = computed(() => [...new Set(IMPORT_FORMATS.map((f) => f.label))].join(' · '))

function take(file: File | undefined): void {
  if (!file) return
  const result = inspectFile(file, props.maxBytes)
  if (!result.ok) {
    rejection.value = result.reason ?? 'That file cannot be imported.'
    emit('update:modelValue', null)
    return
  }
  rejection.value = null
  emit('update:modelValue', file)
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  take(event.dataTransfer?.files?.[0])
}

function clear(): void {
  rejection.value = null
  emit('update:modelValue', null)
  if (input.value) input.value.value = ''
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-2">
    <div
      class="kn-drop relative flex min-h-0 flex-1 rounded-xl border border-dashed"
      :class="[
        dragging ? 'kn-drop-active border-primary bg-primary/5' : 'border-border bg-muted/30',
        rejection && !dragging ? 'border-destructive/50 bg-destructive/5' : '',
        !dragging && !rejection ? 'hover:border-primary/40 hover:bg-muted/50' : '',
      ]"
      @dragenter.prevent="dragging = true"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <!-- Chosen state: the file itself is the content, centred in the same
           field the invitation occupied, so nothing jumps when it lands. -->
      <div v-if="modelValue" key="chosen" class="kn-drop-chosen flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <span class="flex size-14 shrink-0 items-center justify-center rounded-xl bg-background text-primary shadow-sm">
          <component :is="Icon" class="size-7" aria-hidden="true" />
        </span>
        <span class="min-w-0 max-w-full">
          <span class="block truncate text-lg font-medium">{{ modelValue.name }}</span>
          <span class="mt-0.5 block text-sm text-muted-foreground">
            {{ verdict?.label }} · {{ formatBytes(modelValue.size) }}
          </span>
        </span>
        <Button variant="ghost" size="sm" :disabled="disabled" @click="clear">
          <X class="size-4" aria-hidden="true" />
          Choose a different file
        </Button>
      </div>

      <button
        v-else
        type="button"
        class="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl px-6 py-10 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        :disabled="disabled"
        @click="input?.click()"
      >
        <FileUp class="kn-drop-icon mb-2 size-8 text-muted-foreground" aria-hidden="true" />
        <span class="text-base font-medium">{{ t('import.dropFile') }}</span>
        <span class="mt-0.5 max-w-sm text-sm text-muted-foreground">{{ offered }}</span>
        <span class="text-xs text-muted-foreground">Up to {{ formatBytes(maxBytes) }}</span>
      </button>

      <input
        ref="input"
        type="file"
        class="sr-only"
        :accept="ACCEPT_ATTR"
        :disabled="disabled"
        @change="take(($event.target as HTMLInputElement).files?.[0])"
      />
    </div>

    <p v-if="rejection" class="text-sm text-destructive" role="alert">{{ rejection }}</p>
  </div>
</template>

<style scoped>
.kn-drop {
  transition:
    border-color 150ms ease-out,
    background-color 150ms ease-out,
    box-shadow 200ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

/* Holding a file over the zone: it rises very slightly and picks up a ring in
   the accent. Small on purpose — this is an answer, not an event. */
.kn-drop-active {
  transform: scale(1.006);
  box-shadow: 0 8px 24px -12px color-mix(in oklch, var(--primary) 45%, transparent);
}

.kn-drop-active .kn-drop-icon {
  transform: translateY(-2px);
}

.kn-drop-icon {
  transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

/* The chosen file arrives — it does not replace the invitation mid-blink. */
.kn-drop-chosen {
  animation: kn-drop-settle 260ms cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes kn-drop-settle {
  from {
    opacity: 0;
    transform: scale(0.985);
  }
}

@media (prefers-reduced-motion: reduce) {
  .kn-drop,
  .kn-drop-icon {
    transition: border-color 150ms ease-out, background-color 150ms ease-out;
  }
  .kn-drop-active {
    transform: none;
  }
  /* The arrival still reads, without the travel. */
  .kn-drop-chosen {
    animation: kn-drop-fade 160ms ease;
  }
  @keyframes kn-drop-fade {
    from {
      opacity: 0;
    }
  }
}
</style>
