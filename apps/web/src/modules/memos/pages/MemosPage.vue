<script setup lang="ts">
/**
 * /memos (#551, docs/features/68): your recordings, newest first. A memo is
 * the uploader's alone, so there is no "by" column and no filter for someone
 * else's — the list is what the API answers you with.
 *
 * Scoped to the active project, because that is where a memo's proposals are
 * filed. Polled while any memo is still moving; the row is the truth. With no
 * speech endpoint on the server the page says which variable to set instead
 * of offering an upload that would be refused.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type { MemoInfo, MemoListResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { formatDateTime, formatDuration, formatRelative } from '@/shared/utils/format'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/shared/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { PageLayout, PageState } from '@/shared/layout'
import MemoActions from '@/modules/memos/components/MemoActions.vue'
import MemoListPlayer from '@/modules/memos/components/MemoListPlayer.vue'
import MemoTypesDialog from '@/modules/memos/components/MemoTypesDialog.vue'
import MemoUpload from '@/modules/memos/components/MemoUpload.vue'
import PlaudPanel from '@/modules/memos/components/PlaudPanel.vue'
import { useMemoListPlayer } from '@/modules/memos/model/memo-player'
import { useMemoTypes } from '@/modules/memos/model/memo-types'
import { MEMO_STATUS_CLASS, MEMO_STATUS_ICON, isMemoInFlight } from '@/modules/memos/model/memo-ui'

const { t } = useI18n()
const projects = useProjectsStore()
const workspaceId = getWorkspaceId()

/** The list's one filter (#879): a kind of recording, or all of them. */
const ALL = 'all'
const auth = useAuthStore()
const { offered, labelOf, nameOf } = useMemoTypes(workspaceId)
const typeFilter = ref(ALL)
const typesOpen = ref(false)

const listQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/memos', {
      query: { workspaceId, ...(projects.activeId ? { projectId: projects.activeId } : {}), ...(typeFilter.value !== ALL ? { type: typeFilter.value } : {}) },
    }),
    refetchInterval: (q: { state: { data: unknown } }) =>
      (q.state.data as MemoListResponse | undefined)?.memos.some((m) => isMemoInFlight(m.status)) ? 3000 : false,
  })),
)
const data = computed(() => listQuery.data.value as MemoListResponse | undefined)
const memos = computed(() => data.value?.memos ?? [])
const player = useMemoListPlayer()
/** Only where there is audio to play: a Plaud memo's stays in Plaud, and retention purges the rest. */
const playable = (m: MemoInfo) => m.audioAvailable && m.status !== 'pending'
</script>

<template>
  <PageLayout variant="list" :title="t('memos.title')" :subtitle="t('memos.subtitle')">
    <PageState v-if="listQuery.isPending.value" state="loading" :rows="3" row-class="h-14" />
    <PageState v-else-if="listQuery.isError.value" state="error" :error="listQuery.error.value" />

    <template v-else-if="data">
      <div v-if="!data.transcription.enabled" role="status" class="kn-callout-warning kn-measure rounded-md border px-4 py-3 text-sm">
        <p class="font-medium">{{ t('memos.disabled.title') }}</p>
        <i18n-t keypath="memos.disabled.body" tag="p" class="mt-1">
          <template #variable><code class="text-foreground">{{ data.transcription.missing }}</code></template>
        </i18n-t>
      </div>
      <MemoUpload
        v-else
        :workspace-id="workspaceId"
        :project-id="projects.activeId"
        :max-bytes="data.limits.maxBytes"
        :max-minutes="data.limits.maxMinutes"
      />

      <!-- A second source of memos (#864); it draws nothing where Plaud is not offered. -->
      <PlaudPanel :workspace-id="workspaceId" />

      <!-- The upload above is already the call to action; a second framed
           "nothing here" box would only repeat it. -->
      <div v-if="memos.length || typeFilter !== ALL" class="flex flex-wrap items-center gap-2">
        <Select v-model="typeFilter">
          <SelectTrigger size="sm" class="w-52" :aria-label="t('memos.types.filter')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem :value="ALL">{{ t('memos.types.all') }}</SelectItem>
            <SelectItem v-for="type in offered" :key="type.key" :value="type.key">{{ nameOf(type) }}</SelectItem>
          </SelectContent>
        </Select>
        <Button v-if="auth.canAdminWorkspace" size="sm" variant="ghost" @click="typesOpen = true">{{ t('memos.types.manage') }}</Button>
      </div>

      <p v-if="!memos.length" class="text-muted-foreground kn-measure text-sm">{{ t(typeFilter === ALL ? 'memos.empty' : 'memos.types.noneOfType') }}</p>

      <ul v-else class="divide-y rounded-lg border bg-card">
        <li v-for="m in memos" :key="m.memoId" class="hover:bg-muted/50 flex items-center pr-2">
          <!-- The link and the player are siblings: a control inside a link is invalid markup. The player
               sits under the row's own lines, on their left edge. -->
          <div class="min-w-0 flex-1">
            <RouterLink
              :to="`/memos/${m.memoId}`"
              class="focus-visible:ring-ring flex items-center gap-3 py-3 pr-2 pl-4 outline-none focus-visible:ring-2 focus-visible:ring-inset"
              :class="playable(m) ? 'pb-1.5' : ''"
            >
              <component
                :is="MEMO_STATUS_ICON[m.status]"
                class="size-4 shrink-0"
                :class="[MEMO_STATUS_CLASS[m.status], m.status === 'transcribing' ? 'motion-safe:animate-spin' : '']"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium">{{ m.title }}</p>
                <p class="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
                  <span :class="MEMO_STATUS_CLASS[m.status]">{{ t(`memos.status.${m.status}`) }}</span>
                  <span v-if="labelOf(m.type)">{{ labelOf(m.type) }}</span>
                  <span v-if="m.durationSeconds" class="tabular-nums">{{ formatDuration(m.durationSeconds * 1000) }}</span>
                  <span :title="formatDateTime(m.createdAt)">{{ formatRelative(m.createdAt) }}</span>
                </p>
              </div>
            </RouterLink>
            <MemoListPlayer
              v-if="playable(m)"
              class="pb-2.5 pl-11"
              :memo-id="m.memoId"
              :title="m.title"
              :duration-seconds="m.durationSeconds"
              :player="player"
            />
          </div>
          <MemoActions :memo-id="m.memoId" :title="m.title" />
        </li>
      </ul>
    </template>
    <MemoTypesDialog v-if="auth.canAdminWorkspace" v-model:open="typesOpen" :workspace-id="workspaceId" />
  </PageLayout>
</template>
