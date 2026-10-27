<script setup lang="ts">
/**
 * A repository's branch, read through a connection (#564): GitHub (App or
 * token) and GitLab alike. Default first; the empty choice means "follow the
 * default", as #28 made it, so a renamed default never strands a connector.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import type { ConnectionBranchesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const props = defineProps<{ connectionId: string; repo: string; defaultBranch: string | null; modelValue: string; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()
const { t } = useI18n()

const query = useQuery(computed(() => apiQueryOptions('/v1/connections/{id}/branches', { path: { id: props.connectionId }, query: { repo: props.repo } })))
const data = computed(() => query.data.value as ConnectionBranchesResponse | undefined)
const branches = computed(() => (data.value?.branches ?? []).filter((b) => !b.isDefault))

/** Select items cannot carry an empty value; this sentinel is "follow the default". */
const FOLLOW = '__default__'
const value = computed({
  get: () => props.modelValue || FOLLOW,
  set: (v: string) => emit('update:modelValue', v === FOLLOW ? '' : v),
})
</script>

<template>
  <label class="block min-w-0 space-y-1">
    <span class="text-muted-foreground text-xs">{{ label }}</span>
    <Select v-model="value">
      <SelectTrigger class="h-8 w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem :value="FOLLOW">
          {{ defaultBranch ? t('connectors.link.followDefault', { branch: defaultBranch }) : t('connectors.defaultBranch') }}
        </SelectItem>
        <SelectItem v-for="b in branches" :key="b.name" :value="b.name">{{ b.name }}</SelectItem>
      </SelectContent>
    </Select>
    <span v-if="data?.error" class="text-destructive block text-xs">{{ data.error }}</span>
  </label>
</template>
