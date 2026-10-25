<script setup lang="ts">
/**
 * Deleting a workspace (#479): the cascade half of DeleteProjectDialog, one
 * level up, so the two destructive acts in the product read alike.
 *
 * There is no "move" here — a workspace is the tenant, nothing outside it can
 * take its contents — so the dialog is the manifest and the typed name. The
 * counts are the argument ("12 pages" and "340 stored files" are different
 * sentences), zeroes are dropped, and the name is checked here and again on the
 * server, because an irreversible act should not be confirmable only by the
 * client that asked for it.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from 'lucide-vue-next'
import type {
  DeleteWorkspaceResponse,
  WorkspaceDeletionPreviewResponse,
  WorkspaceSummary,
} from '@knowledge/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { api, fetchApi } from '@/api/queries'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

const props = defineProps<{ open: boolean; workspace: WorkspaceSummary }>()
const emit = defineEmits<{ 'update:open': [boolean]; deleted: [result: DeleteWorkspaceResponse] }>()

const preview = ref<WorkspaceDeletionPreviewResponse | null>(null)
const failed = ref<string | null>(null)
const typedName = ref('')
const working = ref(false)
const queryClient = useQueryClient()

// Re-seeded per opening: a workspace's holdings change while the page is up,
// and a stale manifest is worse than a moment's wait.
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    preview.value = null
    failed.value = null
    typedName.value = ''
    try {
      preview.value = await fetchApi(
        queryClient,
        '/v1/workspaces/{id}/deletion-preview',
        { path: { id: props.workspace.workspaceId } },
        { fresh: true },
      )
    } catch (e) {
      failed.value = (e as Error).message
    }
  },
  { immediate: true },
)

// In the server's order (projects first, stored files mid-list); zeroes are a line to check and discard.
const rows = computed(() => Object.entries(preview.value?.counts ?? {}).filter(([, n]) => n > 0))

const ready = computed(() => !!preview.value && typedName.value === props.workspace.name && !working.value)

async function confirm() {
  if (!ready.value) return
  working.value = true
  failed.value = null
  try {
    const res = await api.delete('/v1/workspaces/{id}', {
      path: { id: props.workspace.workspaceId },
      query: { confirm: typedName.value },
    })
    emit('deleted', res)
    emit('update:open', false)
  } catch (e) {
    // The API's message arrives translated and names what refused.
    failed.value = (e as Error).message
  } finally {
    working.value = false
  }
}
</script>

<template>
  <AlertDialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <AlertDialogContent class="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle class="break-words">{{ t('access.deleteWorkspace.title', { name: workspace.name }) }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ preview || failed ? t('access.deleteWorkspace.body') : t('common.loading') }}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div v-if="preview" class="space-y-3">
        <!-- The manifest, in the units that decide it. -->
        <ul v-if="rows.length" class="grid gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 p-3 sm:grid-cols-2">
          <li v-for="[key, n] in rows" :key="key" class="text-destructive flex items-center gap-2 text-sm tabular-nums">
            <TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
            <span>{{ t(`access.deleteWorkspace.count.${key}`, { n }, n) }}</span>
          </li>
        </ul>
        <p v-else class="text-muted-foreground text-sm">{{ t('access.deleteWorkspace.empty') }}</p>

        <p class="text-sm font-medium">{{ t('project.delete.irreversible') }}</p>
        <label class="block space-y-1">
          <span class="text-muted-foreground text-xs break-words">
            {{ t('project.delete.typeName', { name: workspace.name }) }}
          </span>
          <Input
            v-model="typedName"
            :placeholder="workspace.name"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter.prevent="confirm"
          />
        </label>
      </div>

      <p v-if="failed" class="text-destructive text-sm" role="alert">{{ failed }}</p>

      <AlertDialogFooter>
        <AlertDialogCancel :disabled="working">{{ t('common.cancel') }}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" :disabled="!ready" @click.prevent="confirm">
          {{ working ? t('project.delete.deleting') : t('access.deleteWorkspace.confirm') }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
