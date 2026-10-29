<script setup lang="ts">
/**
 * Where the code a component page declares is used (#236, phase 3): each
 * importing file at the connector's indexed head, and the pages documenting
 * it. Computed on read by the API, never written into the page.
 *
 * Every path is shown — the reader can open this page, and paths are code.
 * A documenting page the reader may not open arrives as a count, never a
 * title, and is shown as one.
 *
 * A usage file nothing documents offers an editor "Document" (phase 5): the
 * archaeologist drafts a component page for it, placed beside this one, and
 * the draft opens as a merge request — nothing is published from here.
 */
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { FileCode, FilePlus2 } from 'lucide-vue-next'
import type { CodeUsagesResponse, DraftComponentResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { errorDetails, errorMessage, errorReason } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/shared/ui/button'
import ComponentDraftStatus from './ComponentDraftStatus.vue'

const props = defineProps<{ documentId: string; projectId?: string | null; parentId?: string | null }>()
const { t } = useI18n()
const auth = useAuthStore()

const query = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/component/usages', { path: { id: props.documentId } })),
)
const usages = computed(() => query.data.value as CodeUsagesResponse | undefined)

/**
 * Per usage file, the draft this session asked for: its run, a merge request a
 * duplicate press was refused with, or why it was refused. Kept for the page's
 * life only — the run and the merge request are the record.
 */
const drafts = reactive(new Map<string, { runId?: string; mergeRequestId?: string; error?: string }>())
const startDraft = useApiMutation('post', '/v1/components/drafts')

async function documentFile(path: string) {
  const connectorId = usages.value?.connector?.id
  if (!connectorId || drafts.get(path)?.runId) return
  drafts.set(path, {})
  try {
    const res = (await startDraft.mutateAsync({
      body: {
        workspaceId: getWorkspaceId(),
        connectorId,
        paths: [path],
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(props.parentId ? { parentId: props.parentId } : {}),
      },
    })) as DraftComponentResponse
    drafts.set(path, { runId: res.runId })
  } catch (error) {
    // A second press while the first is drafting or waiting for review points
    // at what already exists rather than reporting a failure.
    const details = errorDetails(error)
    const reason = errorReason(error)
    if (reason === 'in-flight' && typeof details?.runId === 'string') drafts.set(path, { runId: details.runId })
    else if (reason === 'already-proposed' && typeof details?.mergeRequestId === 'string') {
      drafts.set(path, { mergeRequestId: details.mergeRequestId })
    } else drafts.set(path, { error: errorMessage(error, t) })
  }
}

/** `default` and `*` read as what they are; a side-effect import has no names at all. */
function namesOf(imports: CodeUsagesResponse['usages'][number]['imports']): string {
  const names = [...new Set(imports.flatMap((i) => i.names))].map((n) =>
    n === '*' ? t('component.usedBy.everything') : n,
  )
  return names.length ? names.join(', ') : t('component.usedBy.sideEffect')
}
</script>

<template>
  <p v-if="query.isPending.value" class="text-xs text-muted-foreground">{{ t('common.loading') }}</p>
  <p v-else-if="query.isError.value" class="text-xs text-destructive">{{ (query.error.value as Error).message }}</p>
  <!-- The notice above the body says why; here it is enough to say there is nothing to list. -->
  <p v-else-if="usages?.warning" class="text-xs text-muted-foreground">{{ t('component.usedBy.unresolved') }}</p>
  <div v-else-if="usages" class="space-y-3">
    <p class="text-xs text-muted-foreground">
      {{ t('count.usages', { n: usages.usages.length + usages.truncated }, usages.usages.length + usages.truncated) }}
      <template v-if="usages.connector"> · {{ usages.connector.name }}</template>
      <template v-if="usages.headSha">
        · <span class="font-mono">{{ usages.headSha.slice(0, 7) }}</span>
      </template>
    </p>

    <p v-if="!usages.usages.length" class="text-xs text-muted-foreground">
      {{ usages.headSha ? t('component.usedBy.none') : t('component.usedBy.notIndexed') }}
    </p>

    <ul v-else class="max-h-80 space-y-2 overflow-y-auto pr-1">
      <li v-for="site in usages.usages" :key="site.path" class="space-y-0.5">
        <p class="flex items-center gap-1.5 text-xs">
          <FileCode class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="truncate font-mono" :title="site.path">{{ site.path }}</span>
        </p>
        <p class="truncate pl-5 text-xs text-muted-foreground" :title="namesOf(site.imports)">
          {{ namesOf(site.imports) }}
        </p>
        <p class="flex flex-wrap gap-x-2 gap-y-0.5 pl-5 text-xs">
          <RouterLink
            v-for="page in site.pages"
            :key="page.id"
            :to="`/documents/${page.id}`"
            class="underline underline-offset-2 hover:text-foreground"
          >
            {{ page.title }}
          </RouterLink>
          <span v-if="site.hiddenPages" class="text-muted-foreground">
            {{ t('component.usedBy.hiddenPages', { n: site.hiddenPages }, site.hiddenPages) }}
          </span>
          <span v-if="!site.pages.length && !site.hiddenPages" class="text-muted-foreground">
            {{ t('component.usedBy.undocumented') }}
          </span>
        </p>
        <div v-if="!site.pages.length && !site.hiddenPages && auth.canEdit && usages.connector" class="pl-5">
          <ComponentDraftStatus v-if="drafts.get(site.path)?.runId" :run-id="drafts.get(site.path)!.runId!" />
          <p v-else-if="drafts.get(site.path)?.mergeRequestId" class="text-xs">
            <RouterLink
              :to="`/merge-requests/${drafts.get(site.path)!.mergeRequestId}`"
              class="underline underline-offset-2 hover:text-foreground"
            >
              {{ t('component.draft.review') }}
            </RouterLink>
          </p>
          <template v-else>
            <Button
              variant="ghost"
              size="sm"
              class="-ml-2 h-6 px-2 text-xs"
              :disabled="drafts.has(site.path) && !drafts.get(site.path)?.error"
              :title="t('component.draft.hint')"
              @click="documentFile(site.path)"
            >
              <FilePlus2 class="size-3.5" aria-hidden="true" />
              {{ t('component.draft.action') }}
            </Button>
            <p v-if="drafts.get(site.path)?.error" class="text-xs text-destructive">{{ drafts.get(site.path)!.error }}</p>
          </template>
        </div>
      </li>
    </ul>
    <p v-if="usages.truncated" class="text-xs text-muted-foreground">
      {{ t('common.andNMore', { n: usages.truncated }) }}
    </p>

    <div v-if="usages.components.length || usages.hiddenComponents" class="border-t pt-2 text-xs">
      <p class="mb-1 text-muted-foreground">{{ t('component.usedBy.alsoDeclaredBy') }}</p>
      <p class="flex flex-wrap gap-x-2 gap-y-0.5">
        <RouterLink
          v-for="page in usages.components"
          :key="page.id"
          :to="`/documents/${page.id}`"
          class="underline underline-offset-2 hover:text-foreground"
        >
          {{ page.title }}
        </RouterLink>
        <span v-if="usages.hiddenComponents" class="text-muted-foreground">
          {{ t('component.usedBy.hiddenPages', { n: usages.hiddenComponents }, usages.hiddenComponents) }}
        </span>
      </p>
    </div>
  </div>
</template>
