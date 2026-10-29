<script setup lang="ts">
/**
 * An operation key, resolved (#78): the endpoint line and the spec that defines
 * it, linking to its card. Where a key names an operation no spec the reader
 * can open defines — removed, renamed, or mistyped — it says so, so a relation
 * row or a workflow item never looks linked when it is not.
 */
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from 'lucide-vue-next'
import ApiEndpoint from './ApiEndpoint.vue'
import { operationHref, useOperation } from '../model/use-operation'

const props = defineProps<{ workspaceId: string; entityKey: string }>()
const { t } = useI18n()
const { operation, missing } = useOperation(() => props.workspaceId, () => props.entityKey)
</script>

<template>
  <RouterLink
    v-if="operation"
    :to="operationHref(operation)"
    class="group/ref flex min-w-0 flex-col gap-0.5 rounded-md py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <ApiEndpoint :method="operation.method" :path="operation.path" :protocol="operation.protocol" />
    <span class="truncate pl-[3.875rem] text-caption text-muted-foreground group-hover/ref:text-primary">
      {{ operation.summary ? `${operation.summary} · ` : '' }}{{ operation.specTitle }}
    </span>
  </RouterLink>
  <p v-else-if="missing" class="flex items-start gap-1.5 text-caption leading-snug text-muted-foreground">
    <AlertTriangle class="mt-px size-3 shrink-0 text-[color-mix(in_oklch,var(--kn-panel-warning)_75%,var(--foreground))]" />
    {{ t('apiLink.gone') }}
  </p>
</template>
