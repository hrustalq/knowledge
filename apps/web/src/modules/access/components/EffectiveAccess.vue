<script setup lang="ts">
/**
 * "Who can see this" (#76): everyone who may open one page or project, at what
 * level, and why — a workspace admin, their workspace role, or a grant.
 *
 * The answer is the server's (`GET …/access/effective`), never recomputed here:
 * the chain of restrictions, group membership and the role ceiling all meet in
 * one predicate there, and a second copy in the browser would be a second
 * answer. Only a manager of the node may ask; the dialog shows this tab to
 * nobody else.
 *
 * Fetched when mounted — the dialog mounts it only once its tab is opened.
 */
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AccessResourceType, EffectiveAccessEntry, EffectiveAccessResponse } from '@knowledge/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { fetchApi } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Badge } from '@/shared/ui/badge'
import { Skeleton } from '@/shared/ui/skeleton'
import UserChip from '@/widgets/person/UserChip.vue'

const props = defineProps<{ resourceType: AccessResourceType; resourceId: string }>()

const { t } = useI18n()

const entries = ref<EffectiveAccessEntry[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const queryClient = useQueryClient()

async function load() {
  loading.value = true
  error.value = null
  try {
    // Fresh: the dialog's own saves change the answer and do not touch the cache.
    const path = { id: props.resourceId }
    const res = (
      props.resourceType === 'project'
        ? await fetchApi(queryClient, '/v1/projects/{id}/access/effective', { path }, { fresh: true })
        : await fetchApi(queryClient, '/v1/documents/{id}/access/effective', { path }, { fresh: true })
    ) as EffectiveAccessResponse
    entries.value = res.entries
  } catch (e) {
    entries.value = []
    error.value = errorMessage(e, t)
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [props.resourceType, props.resourceId], () => void load())

defineExpose({ reload: load })
</script>

<template>
  <div class="space-y-3 text-sm">
    <p class="text-muted-foreground text-xs">{{ t('access.page.effectiveHint') }}</p>

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-8 w-full" />
    </div>
    <p v-else-if="error" class="text-destructive">{{ error }}</p>
    <p v-else-if="entries.length === 0" class="text-muted-foreground py-6 text-center">
      {{ t('access.page.effectiveEmpty') }}
    </p>
    <ul v-else class="divide-y rounded-md border">
      <li v-for="entry in entries" :key="entry.userId" class="flex items-center gap-2 px-3 py-2">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <UserChip :user-id="entry.userId" :name="entry.displayName" size="sm" />
          <span class="text-muted-foreground hidden truncate text-xs sm:inline">{{ entry.email }}</span>
        </div>
        <Badge
          variant="outline"
          class="text-muted-foreground shrink-0 font-normal"
          :title="t(`access.page.sourceHint.${entry.source}`, { role: t(`role.${entry.role}`) })"
        >
          {{ t(`access.page.source.${entry.source}`) }}
        </Badge>
        <span class="w-20 shrink-0 text-right font-medium">{{ t(`access.level.${entry.level}`) }}</span>
      </li>
    </ul>
  </div>
</template>
