<script setup lang="ts">
/**
 * What the run found, in the shape the external system has it (docs/features/26).
 *
 * The rows arrive flat and whole — one response for the entire run — so this
 * assembles the tree once and nothing here ever fetches a level. That is the
 * difference from the sidebar page tree it otherwise resembles: there, a level
 * is a query, so a twisty is a load; here a twisty is a fold.
 *
 * The counts above the tree are the honest summary of a staged run, and they
 * are worth more than they look: on a second sync almost every row should read
 * `unchanged`, and that line is where a reviewer sees at a glance whether the
 * sync is idempotent or whether something is churning.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderTree } from 'lucide-vue-next'
import type { ConnectorItemEventType, ConnectorRunItemInfo } from '@knowledge/contracts'
import AiEmptyState from '@/components/ai/AiEmptyState.vue'
import ConnectorRunTreeNode from './ConnectorRunTreeNode.vue'
import { ACTION_CLASS, ACTION_LABEL, nestItems } from './connector-ui'

const props = defineProps<{
  items: ConnectorRunItemInfo[]
  selectedId: string | null
  busyIds: Set<string>
  canManage: boolean
  /** The walk stopped at CONNECTOR_SYNC_MAX_ITEMS; say so rather than imply completeness. */
  truncated: boolean
}>()

const emit = defineEmits<{
  select: [string]
  event: [{ itemId: string; type: ConnectorItemEventType; subtree: boolean }]
}>()

const { t } = useI18n()

const roots = computed(() => nestItems(props.items))

/** Only the actions actually present — no zeroed placeholders. */
const tally = computed(() => {
  const counts = new Map<string, number>()
  for (const item of props.items) {
    if (item.action) counts.set(item.action, (counts.get(item.action) ?? 0) + 1)
  }
  return (['create', 'update', 'conflict', 'unchanged'] as const)
    .filter((action) => counts.has(action))
    .map((action) => ({ action, count: counts.get(action)! }))
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs">
      <span class="text-muted-foreground">
        {{ t('connectors.itemCount', { count: items.length }, items.length) }}
      </span>
      <span v-for="{ action, count } in tally" :key="action" class="font-medium" :class="ACTION_CLASS[action]">
        {{ count }} {{ t(ACTION_LABEL[action]).toLocaleLowerCase() }}
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
      <AiEmptyState
        v-if="!items.length"
        :icon="FolderTree"
        :title="t('connectors.noItemsTitle')"
        :body="t('connectors.noItemsBody')"
      />

      <ul v-else>
        <ConnectorRunTreeNode
          v-for="node in roots"
          :key="node.item.id"
          :node="node"
          :depth="0"
          :selected-id="selectedId"
          :busy-ids="busyIds"
          :can-manage="canManage"
          @select="emit('select', $event)"
          @event="emit('event', $event)"
        />
      </ul>

      <p v-if="truncated" class="text-muted-foreground border-t px-2 py-2 text-xs">
        {{ t('connectors.itemsTruncated') }}
      </p>
    </div>
  </div>
</template>
