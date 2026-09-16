<script setup lang="ts">
/**
 * The four things a page shows instead of its content.
 *
 * PRODUCT.md names empty states as a known gap, and the count says why: eight
 * pages drew their own dashed block, each with a different anatomy, and the
 * three pages that could be refused by the API expressed it three different
 * ways — a destructive paragraph, an outline badge reading "read-only", and a
 * whole route (`/403`). A reader met all three and learned nothing from any of
 * them twice.
 *
 * Kept as one component rather than four because the decision is the same
 * decision. A page asks "what am I showing instead of rows?", and the answer
 * has one shape: a mark, a sentence naming the situation, a sentence naming the
 * way out, and the control that takes it.
 *
 * `forbidden` is deliberately not `error`. Being unable to edit something is
 * not a failure — nothing went wrong, and tinting it red tells the reader to go
 * looking for a problem that does not exist. It is muted, and it says who can
 * grant the access rather than only that it is missing.
 *
 * The empty block's copy is a prop rather than a default, because the useful
 * version names *this* page's subject ("No merge requests are open") and the
 * generic one never can. The fallback exists so a page cannot render blank.
 */
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlert, Inbox, Lock } from 'lucide-vue-next'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/api/errors'

const props = withDefaults(
  defineProps<{
    state: 'loading' | 'empty' | 'error' | 'forbidden'
    title?: string
    description?: string
    /** Empty state only — the page's own subject reads better than a generic tray. */
    icon?: Component
    /** Anything thrown. Rendered through the shared envelope reader, never raw. */
    error?: unknown
    /** Loading only: how many placeholder rows, and how tall each one is. */
    rows?: number
    rowClass?: string
  }>(),
  {
    title: undefined,
    description: undefined,
    icon: undefined,
    error: undefined,
    rows: 4,
    rowClass: 'h-20',
  },
)

const { t } = useI18n()

const heading = computed(() => {
  if (props.title) return props.title
  switch (props.state) {
    case 'error':
      return t('page.errorTitle')
    case 'forbidden':
      return t('page.forbiddenTitle')
    default:
      return t('page.empty')
  }
})

const body = computed(() => {
  if (props.description) return props.description
  if (props.state === 'error' && props.error !== undefined) return errorMessage(props.error, t)
  if (props.state === 'forbidden') return t('page.forbiddenHint')
  return ''
})

const mark = computed<Component>(() => {
  if (props.icon) return props.icon
  return props.state === 'error' ? CircleAlert : props.state === 'forbidden' ? Lock : Inbox
})
</script>

<template>
  <!-- Placeholders are shaped like the rows they stand in for, so the page does
       not visibly re-flow the moment real content lands on top of them. -->
  <div v-if="state === 'loading'" class="space-y-2" aria-hidden="true">
    <Skeleton v-for="i in rows" :key="i" :class="rowClass" class="w-full" />
  </div>

  <div
    v-else
    class="flex flex-col items-center gap-3 rounded-lg border px-6 py-14 text-center"
    :class="
      state === 'error'
        ? 'border-destructive/30 bg-destructive/5'
        : 'border-dashed text-muted-foreground'
    "
    :role="state === 'error' ? 'alert' : undefined"
  >
    <component
      :is="mark"
      class="size-8"
      :class="state === 'error' ? 'text-destructive' : 'opacity-40'"
      aria-hidden="true"
    />
    <div class="min-w-0">
      <p class="text-sm font-medium" :class="state === 'error' ? 'text-destructive' : 'text-foreground'">
        {{ heading }}
      </p>
      <p v-if="body" class="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{{ body }}</p>
    </div>
    <slot name="actions" />
  </div>
</template>
