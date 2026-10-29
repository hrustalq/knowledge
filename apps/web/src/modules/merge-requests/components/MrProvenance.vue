<script setup lang="ts">
// Where a merge request came from, when a person did not open it by hand
// (issue #73): "Captured from Claude Code · acme/api@3f2a9c1 · feat/auth ·
// session 1a2b3c4d". It sits under the header, beside who requested the merge,
// because it answers the same question — whose proposal is this — and a
// reviewer reads it before the diff, not after.
//
// Every field is the agent's own report: the server infers none of it, so the
// strip says "reported" in its title rather than presenting it as verified.
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { Bot } from 'lucide-vue-next'
import type { CaptureInfo, MergeRequestInfo } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { CaptureOriginParts, clientLabel, repoAtCommit } from '@/entities/capture'
import { useFeaturesStore } from '@/stores/features'

const { t } = useI18n()

const props = defineProps<{ mergeRequest: MergeRequestInfo }>()

const captureId = computed(() => props.mergeRequest.captureId ?? null)
const features = useFeaturesStore()
const captureQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/captures/{id}', { path: { id: captureId.value ?? '' } }),
    // With captures switched off (#604) the MR still says it was captured, without the session.
    enabled: !!captureId.value && features.isOn('captures'),
  })),
)
const capture = computed(() => captureQuery.data.value as CaptureInfo | undefined)
const session = computed(() => capture.value?.session ?? null)
const repo = computed(() => (session.value ? repoAtCommit(session.value) : null))
/** A chat capture's origin is the server's, not a report (#82): the "reported" hint would be untrue. */
const origin = computed(() => capture.value?.origin ?? null)
</script>

<template>
  <div
    v-if="mergeRequest.provenance !== 'manual'"
    class="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    :title="mergeRequest.provenance === 'captured' && !origin ? t('mr.provenance.reportedHint') : undefined"
  >
    <Bot class="size-3.5 shrink-0 text-foreground/70" aria-hidden="true" />

    <template v-if="mergeRequest.provenance === 'agent'">
      <span>{{ t('mr.provenance.agentStrip') }}</span>
    </template>

    <template v-else>
      <span>
        {{ t('mr.provenance.capturedFrom') }}
        <span class="font-medium text-foreground">{{ session ? clientLabel(session.client, t) : t('mr.provenance.anAgent') }}</span>
      </span>
      <CaptureOriginParts v-if="origin" :origin="origin" />
      <template v-if="repo">
        <span aria-hidden="true">·</span>
        <code class="font-mono text-caption text-foreground/80" :title="session?.repo">{{ repo }}</code>
      </template>
      <template v-if="session?.branch">
        <span aria-hidden="true">·</span>
        <code class="max-w-56 truncate font-mono text-caption" :title="session.branch">{{ session.branch }}</code>
      </template>
      <template v-if="session?.sessionId">
        <span aria-hidden="true">·</span>
        <span :title="session.sessionId">
          {{ t('mr.provenance.session') }} <code class="font-mono text-caption">{{ session.sessionId.slice(0, 8) }}</code>
        </span>
      </template>
      <RouterLink
        v-if="captureId"
        :to="{ path: '/captures', query: { tab: 'proposed' } }"
        class="ml-auto font-medium text-primary hover:underline"
      >
        {{ t('mr.provenance.viewCaptures') }}
      </RouterLink>
    </template>
  </div>
</template>
