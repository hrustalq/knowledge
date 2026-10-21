<script setup lang="ts">
/**
 * A snippet someone is going to paste somewhere else, with the button that
 * puts it on their clipboard. The label names the destination (a file path,
 * "Terminal") because "where does this go" is the question every snippet on
 * the connect page raises before "what does it say".
 */
import { useI18n } from 'vue-i18n'
import { Check, Copy, X } from 'lucide-vue-next'
import { useCopy } from '@/lib/use-copy'

const props = defineProps<{ code: string; label?: string; secret?: boolean }>()

const { t } = useI18n()
const { state, copy } = useCopy()
</script>

<template>
  <div class="min-w-0 overflow-hidden rounded-lg border">
    <div class="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-1">
      <span class="min-w-0 truncate font-mono text-caption text-muted-foreground">{{ props.label }}</span>
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
        @click="copy(props.code)"
      >
        <Check v-if="state === 'copied'" class="size-3" />
        <X v-else-if="state === 'failed'" class="size-3" />
        <Copy v-else class="size-3" />
        {{ state === 'copied' ? t('common.copied') : state === 'failed' ? t('connect.copyFailed') : t('common.copy') }}
      </button>
    </div>
    <!-- Focusable because it scrolls sideways: a long command must be readable
         from the keyboard too. `group` is a nameable role; a bare <pre> is not. -->
    <pre
      tabindex="0"
      role="group"
      :aria-label="props.label"
      class="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset"
      :class="props.secret ? 'select-all' : ''"
    ><code>{{ props.code }}</code></pre>
  </div>
</template>
