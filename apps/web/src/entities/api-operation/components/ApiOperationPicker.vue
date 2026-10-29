<script setup lang="ts">
/**
 * "Link API operation" (#78): a popover that searches every spec the reader may
 * open, server-side, and hands back one operation. The editor's relation rows
 * and the API contract block both open it, so a key is always picked from what
 * a spec defines rather than typed from memory — a near-miss key is a second
 * vertex, not a link.
 *
 * Built on the same reka primitives and surface as `ui/combobox`, which filters
 * a roster it already holds; this one asks the API on each (debounced) query,
 * because a workspace's operations are unbounded.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { refDebounced } from '@vueuse/core'
import { keepPreviousData, useQuery } from '@tanstack/vue-query'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxViewport,
} from 'reka-ui'
import { Loader2, Search } from 'lucide-vue-next'
import type { ApiOperationInfo } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { operationRowKey } from '@/entities/api-operation/model/api-spec'
import ApiEndpoint from './ApiEndpoint.vue'
import ApiTone from './ApiTone.vue'

export type PickedOperation = ApiOperationInfo & { specTitle: string }

const props = withDefaults(
  defineProps<{
    workspaceId: string
    /** Only this kind: an HTTP endpoint block cannot mirror an AsyncAPI channel. */
    protocol?: 'http' | 'async'
    align?: 'start' | 'center' | 'end'
    disabled?: boolean
  }>(),
  { align: 'start' },
)
const emit = defineEmits<{ pick: [operation: PickedOperation] }>()
const { t } = useI18n()

const open = ref(false)
const query = ref('')
const debounced = refDebounced(query, 200)

const results = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/api-operations', {
      query: { workspaceId: props.workspaceId, q: debounced.value.trim() || undefined, limit: 40 },
    }),
    enabled: open.value,
    placeholderData: keepPreviousData,
  })),
)
const operations = computed(() =>
  (results.data.value?.operations ?? []).filter(
    (o) => !props.protocol || o.protocol === props.protocol,
  ),
)
const byKey = computed(() => new Map(operations.value.map((o) => [operationRowKey(o), o])))
const searching = computed(() => results.isFetching.value || query.value !== debounced.value)

function select(value: unknown) {
  const op = typeof value === 'string' ? byKey.value.get(value) : undefined
  if (!op) return
  open.value = false
  query.value = ''
  emit('pick', op)
}
</script>

<template>
  <ComboboxRoot
    as="span"
    class="inline-flex"
    v-model:open="open"
    :disabled="disabled"
    ignore-filter
    :reset-search-term-on-blur="false"
    :reset-search-term-on-select="false"
    @update:model-value="select"
  >
    <ComboboxAnchor as-child>
      <slot name="trigger" :open="open" :toggle="() => (open = !open)" />
    </ComboboxAnchor>

    <!-- Portalled: opened from inside an API block's <h3>, inline content
         would inherit the prose surface's heading and code styles. -->
    <ComboboxPortal>
    <ComboboxContent
      position="popper"
      :align="align"
      :side-offset="6"
      class="bg-popover text-popover-foreground z-50 flex max-h-[min(26rem,var(--reka-popper-available-height))] w-[26rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border shadow-[0_12px_32px_-8px] shadow-foreground/15 duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 dark:shadow-black/60"
    >
      <div class="border-border/70 relative shrink-0 border-b">
        <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
        <ComboboxInput
          v-model="query"
          auto-focus
          :aria-label="t('apiLink.search')"
          :placeholder="t('apiLink.placeholder')"
          class="placeholder:text-muted-foreground h-10 w-full bg-transparent pr-9 pl-9 text-ui outline-none"
        />
        <Loader2
          v-if="searching"
          class="text-muted-foreground absolute top-1/2 right-3 size-3.5 -translate-y-1/2 animate-spin motion-reduce:animate-none"
        />
      </div>

      <ComboboxViewport class="quiet-scroll min-h-0 flex-1 overflow-y-auto p-1">
        <p v-if="results.isError.value" class="text-destructive px-3 py-6 text-center text-xs">{{ t('apiLink.failed') }}</p>
        <p v-else-if="!operations.length && !searching" class="text-muted-foreground px-4 py-6 text-center text-xs leading-relaxed">
          {{ debounced.trim() ? t('apiLink.noMatch', { query: debounced.trim() }) : t('apiLink.noSpecs') }}
        </p>
        <ComboboxItem
          v-for="op in operations"
          :key="operationRowKey(op)"
          :value="operationRowKey(op)"
          :text-value="`${op.method ?? ''} ${op.path}`"
          class="data-[highlighted]:bg-accent group/item flex cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 outline-none select-none"
        >
          <span class="flex min-w-0 items-center gap-2">
            <ApiEndpoint :method="op.method" :path="op.path" :protocol="op.protocol" class="flex-1" />
            <ApiTone v-if="op.deprecated" tone="warning" variant="text">{{ t('apiRef.deprecated') }}</ApiTone>
          </span>
          <span class="text-muted-foreground flex min-w-0 gap-1.5 pl-[3.875rem] text-caption leading-snug">
            <span v-if="op.summary" class="min-w-0 truncate">{{ op.summary }}</span>
            <span v-if="op.summary" aria-hidden="true">·</span>
            <span class="shrink-0 truncate">{{ op.specTitle }}</span>
          </span>
        </ComboboxItem>
      </ComboboxViewport>
    </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
