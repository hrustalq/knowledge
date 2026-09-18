<script setup lang="ts">
/**
 * The Work items tab (docs/features/32): issues and pull requests on the
 * connected repository, and the page each one is about.
 *
 * The list is a projection refreshed from the far side on every load, so the
 * one thing this screen owns is the attachment — which page an item is about.
 * That is also the only control here that changes anything locally: everything
 * else either opens GitHub or hands it a new issue.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery } from '@tanstack/vue-query'
import { CircleDot, ExternalLink, GitMerge, GitPullRequest, Plus, X } from 'lucide-vue-next'
import type { ConnectorWorkItemInfo, ListConnectorWorkItemsResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PageState } from '@/components/layout/page'
import { Autocomplete } from '@/components/ui/autocomplete'
import type { AutocompleteOption } from '@/components/ui/autocomplete'
import { useDocumentsStore } from '@/stores/documents'

const props = defineProps<{ connectorId: string; canManage: boolean }>()

const { t } = useI18n()
const documents = useDocumentsStore()

/**
 * Pages to attach to, from the roster the sidebar already loads.
 *
 * Client-side over the loaded list rather than a search request per keystroke,
 * which is what `DocumentPickerWidget` settled on for the same job: attaching a
 * page is a bounded choice from this project, not a hunt through the corpus.
 */
async function loadPages(q: string): Promise<AutocompleteOption[]> {
  if (!documents.loaded) await documents.fetchList()
  const needle = q.trim().toLowerCase()
  return documents.items
    .filter((doc) => !needle || doc.title.toLowerCase().includes(needle))
    .slice(0, 50)
    .map((doc) => ({ value: doc.documentId, label: doc.title }))
}

const query = useQuery(
  computed(() => apiQueryOptions('/v1/connectors/{id}/work-items', { path: { id: props.connectorId } })),
)
const items = computed(() => (query.data.value as ListConnectorWorkItemsResponse | undefined)?.workItems ?? [])

const invalidates = () => [['/v1/connectors/{id}/work-items']]
const createItem = useApiMutation('post', '/v1/connectors/{id}/work-items', { invalidates })
const linkItem = useApiMutation('post', '/v1/connectors/{id}/work-items/{workItemId}/link', { invalidates })
const unlinkItem = useApiMutation('delete', '/v1/connectors/{id}/work-items/{workItemId}/link', { invalidates })

const composerOpen = ref(false)
const title = ref('')
const body = ref('')
// Autocomplete speaks `string[]` even single-select, carrying 0 or 1 entry.
const attachTo = ref<string[]>([])

/** Which row's page picker is open. One at a time: this is a table, not a form. */
const picking = ref<string | null>(null)

async function submit() {
  if (!title.value.trim()) return
  try {
    await createItem.mutateAsync({
      path: { id: props.connectorId },
      body: {
        title: title.value.trim(),
        ...(body.value.trim() ? { body: body.value.trim() } : {}),
        ...(attachTo.value[0] ? { documentId: attachTo.value[0] } : {}),
      },
    })
    toast.success(t('connectors.workItemCreated'))
    composerOpen.value = false
    title.value = ''
    body.value = ''
    attachTo.value = []
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function attach(item: ConnectorWorkItemInfo, documentId: string) {
  picking.value = null
  try {
    await linkItem.mutateAsync({
      path: { id: props.connectorId, workItemId: item.id },
      body: { documentId },
    })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function detach(item: ConnectorWorkItemInfo) {
  try {
    await unlinkItem.mutateAsync({ path: { id: props.connectorId, workItemId: item.id } })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

/**
 * `merged` gets its own mark rather than reading as another closed item — the
 * same distinction the state vocabulary draws, and the reason it exists.
 */
function stateMark(item: ConnectorWorkItemInfo) {
  if (item.state === 'merged') return { icon: GitMerge, class: 'text-violet-500' }
  if (item.state === 'closed') return { icon: CircleDot, class: 'text-muted-foreground' }
  if (item.kind === 'pull-request') return { icon: GitPullRequest, class: 'text-emerald-500' }
  return { icon: CircleDot, class: 'text-emerald-500' }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">
        {{ t('connectors.workItemCount', { count: items.length }, items.length) }}
      </p>
      <Button v-if="canManage" size="sm" @click="composerOpen = true">
        <Plus class="size-3.5" /> {{ t('connectors.workItemNew') }}
      </Button>
    </div>

    <PageState v-if="query.isPending.value" state="loading" />
    <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />
    <PageState
      v-else-if="!items.length"
      state="empty"
      :title="t('connectors.workItemsEmptyTitle')"
      :body="t('connectors.workItemsEmptyBody')"
    />

    <ul v-else class="divide-y rounded-lg border">
      <li v-for="item in items" :key="item.id" class="flex flex-wrap items-start gap-3 p-3">
        <component :is="stateMark(item).icon" class="mt-0.5 size-4 shrink-0" :class="stateMark(item).class" />

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <a
              :href="item.url"
              target="_blank"
              rel="noopener noreferrer"
              class="min-w-0 truncate text-sm font-medium hover:underline"
            >
              {{ item.title }}
            </a>
            <span class="text-muted-foreground shrink-0 text-xs tabular-nums">#{{ item.number }}</span>
            <Badge v-for="label in item.labels.slice(0, 4)" :key="label" variant="outline">{{ label }}</Badge>
            <Badge v-for="board in item.boards" :key="board" variant="secondary">{{ board }}</Badge>
          </div>

          <p class="text-muted-foreground mt-1 text-xs">
            <template v-if="item.authorLogin">{{ item.authorLogin }} · </template>
            {{ t(`connectors.workItemState.${item.state}`) }}
            <template v-if="item.assigneeLogins.length"> · {{ item.assigneeLogins.join(', ') }}</template>
          </p>

          <!-- The attachment: the one fact on this row that is ours, so it is the
               one control. An unattached item is not an error, it is the normal
               state — most issues are nobody's page. -->
          <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <template v-if="item.documentId">
              <RouterLink :to="`/documents/${item.documentId}`" class="hover:underline">
                {{ item.documentTitle ?? t('connectors.workItemLinkedPage') }}
              </RouterLink>
              <Button
                v-if="canManage"
                size="sm"
                variant="ghost"
                class="h-6 px-1.5"
                :disabled="unlinkItem.isPending.value"
                :aria-label="t('connectors.workItemDetach')"
                @click="detach(item)"
              >
                <X class="size-3" />
              </Button>
            </template>
            <template v-else-if="canManage">
              <div v-if="picking === item.id" class="w-full max-w-sm">
                <Autocomplete
                  :model-value="[]"
                  :label="t('connectors.workItemAttach')"
                  :placeholder="t('picker.searchPages')"
                  :load="loadPages"
                  @update:model-value="(ids: string[]) => ids[0] && attach(item, ids[0])"
                />
              </div>
              <button
                v-else
                class="text-muted-foreground hover:text-foreground hover:underline"
                @click="picking = item.id"
              >
                {{ t('connectors.workItemAttach') }}
              </button>
            </template>
          </div>
        </div>

        <a
          :href="item.url"
          target="_blank"
          rel="noopener noreferrer"
          class="text-muted-foreground shrink-0 hover:text-foreground"
          :aria-label="t('connectors.openExternal')"
        >
          <ExternalLink class="size-3.5" />
        </a>
      </li>
    </ul>

    <Dialog v-model:open="composerOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ t('connectors.workItemNew') }}</DialogTitle>
        </DialogHeader>

        <div class="space-y-3">
          <Input v-model="title" :placeholder="t('connectors.workItemTitlePlaceholder')" />
          <Textarea v-model="body" rows="6" :placeholder="t('connectors.workItemBodyPlaceholder')" />
          <p class="text-muted-foreground text-xs">{{ t('connectors.workItemAttachHint') }}</p>
          <Autocomplete
            v-model="attachTo"
            :label="t('connectors.workItemAttach')"
            :placeholder="t('picker.searchPages')"
            :load="loadPages"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="composerOpen = false">{{ t('common.cancel') }}</Button>
          <Button :disabled="!title.trim() || createItem.isPending.value" @click="submit">
            {{ t('connectors.workItemCreate') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
