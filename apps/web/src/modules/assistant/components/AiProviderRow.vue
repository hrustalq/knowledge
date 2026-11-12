<script setup lang="ts">
/**
 * One provider in the list: a connection, whether it is on, and what it serves.
 * Status keeps three icon shapes rather than three colours of one dot, so
 * it reads without colour; a failing check's message sits on its own row, not
 * detached below the list where it could belong to anything.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheck, CircleDashed, CircleOff, CircleX, RefreshCw, Trash2 } from 'lucide-vue-next'
import type { AiProvider } from '@knowledge/contracts'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { Checkbox } from '@knowledge/ui/checkbox'
import { formatDateTime } from '@/shared/utils/format'
import type { ProviderRow } from '@/modules/assistant/model/provider-rows'
import AiModelList from './AiModelList.vue'

const props = defineProps<{ row: ProviderRow; canManage: boolean; testing: boolean }>()
defineEmits<{ edit: []; test: []; remove: []; toggle: [enabled: boolean] }>()

const { t } = useI18n()

const KIND_LABELS: Record<Exclude<AiProvider, 'none' | 'openai-compatible'>, string> = {
  deepseek: 'DeepSeek',
  'gen-api': 'GenAPI',
}

const kindLabel = computed(() => {
  const { kind } = props.row
  if (kind === 'none') return t('ai.providerRow.none')
  return kind === 'openai-compatible' ? t('ai.openaiCompatible') : KIND_LABELS[kind]
})
const title = computed(() => props.row.name ?? kindLabel.value)

/** Nothing to dial: a disabled profile tests the default instead, and `none` refuses. */
const off = computed(() => !props.row.enabled)

const statusLabel = computed(() => {
  if (off.value) return t('ai.providerRow.statusOff')
  const when = props.row.checkedAt ? formatDateTime(props.row.checkedAt) : null
  if (props.row.status === 'ok') return when ? t('ai.providerRow.statusOkAt', { when }) : t('ai.providerRow.statusOk')
  if (props.row.status === 'error') return t('ai.providerRow.statusError')
  return t('ai.providerRow.statusUnknown')
})

const keyLabel = computed(() => {
  const { key } = props.row
  if (key.source === 'stored') return key.hint ?? t('ai.providerRow.keyStored')
  if (key.source === 'environment') return t('ai.providerRow.keyEnvironment')
  if (key.source === 'default') return t('ai.providerRow.keyDefault')
  return t('ai.providerRow.keyMissing')
})
</script>

<template>
  <!-- Actions sit beside the title once the list has room, and below it on a
       phone, where they would otherwise squeeze a name into one word a line. The
       models come last either way: the actions above them are the connection's.
       The list is the container: the row's width, not the viewport's, decides. -->
  <li
    class="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-3 @lg:grid-cols-[1rem_minmax(0,1fr)_auto]"
    :class="off && !row.isDefault && 'bg-muted/30'"
  >
    <span class="mt-0.5" :title="statusLabel">
      <CircleOff v-if="off" class="text-muted-foreground size-4" aria-hidden="true" />
      <CircleCheck v-else-if="row.status === 'ok'" class="text-panel-tip-ink size-4" aria-hidden="true" />
      <CircleX v-else-if="row.status === 'error'" class="text-destructive size-4" aria-hidden="true" />
      <CircleDashed v-else class="text-muted-foreground size-4" aria-hidden="true" />
      <span class="sr-only">{{ statusLabel }}</span>
    </span>

    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          class="focus-visible:ring-ring/50 rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-[3px] disabled:cursor-default"
          :class="canManage && 'hover:text-primary'"
          :disabled="!canManage"
          :aria-label="t('ai.providerRow.editNamed', { name: title })"
          @click="$emit('edit')"
        >
          {{ title }}
        </button>
        <Badge v-if="row.isDefault" variant="outline" class="font-normal">{{ t('ai.default') }}</Badge>
        <Badge v-if="off && !row.isDefault" variant="outline" class="text-muted-foreground font-normal">{{ t('ai.disabled') }}</Badge>
        <span v-if="row.fromEnvironment" class="text-muted-foreground text-xs">{{ t('ai.providerRow.fromEnvironment') }}</span>
      </div>

      <!-- A profile's name says nothing about the vendor, so it carries the kind
           here; the default row's title already is the kind. -->
      <p v-if="row.kind !== 'none'" class="text-muted-foreground mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-xs">
        <span v-if="row.name">{{ kindLabel }}</span>
        <span v-if="row.name" aria-hidden="true">·</span>
        <template v-if="row.host">
          <span class="break-all">{{ row.host }}</span>
          <span aria-hidden="true">·</span>
        </template>
        <span :class="[row.key.source === 'missing' && 'text-destructive', row.key.source === 'stored' && row.key.hint && 'font-mono']">
          {{ keyLabel }}
        </span>
      </p>
      <p v-else class="text-muted-foreground mt-0.5 text-xs">{{ t('ai.providerRow.noneHint') }}</p>
    </div>

    <div v-if="canManage" class="col-start-2 -ml-2 flex flex-wrap items-center gap-0.5 @lg:col-start-3 @lg:-mt-1 @lg:ml-0">
      <!-- The default has no off switch of its own: its off is provider `none`. -->
      <label v-if="!row.isDefault" class="mr-1 ml-2 flex items-center gap-1.5 text-xs">
        <Checkbox :model-value="row.enabled" @update:model-value="$emit('toggle', $event === true)" />
        {{ t('ai.enabled') }}
      </label>
      <Button v-if="!off" type="button" variant="ghost" size="sm" :disabled="testing" @click="$emit('test')">
        <RefreshCw class="size-3.5" :class="testing && 'animate-spin'" aria-hidden="true" />
        {{ t('ai.test') }}
      </Button>
      <Button type="button" variant="ghost" size="sm" @click="$emit('edit')">{{ t('common.edit') }}</Button>
      <Button
        v-if="!row.isDefault"
        type="button"
        variant="ghost"
        size="sm"
        :aria-label="t('ai.removeNamed', { name: title })"
        @click="$emit('remove')"
      >
        <Trash2 class="size-3.5" aria-hidden="true" />
      </Button>
    </div>

    <p v-if="row.error" class="text-destructive col-start-2 text-xs break-words @lg:col-[2/4]">{{ row.error }}</p>

    <div class="col-start-2 @lg:col-[2/4]">
      <AiModelList :row="row" :title="title" :can-manage="canManage" @edit-provider="$emit('edit')" />
    </div>
  </li>
</template>
