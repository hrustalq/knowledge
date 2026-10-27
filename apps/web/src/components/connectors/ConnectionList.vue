<script setup lang="ts">
/**
 * The workspace's connections (#564): one row per account a connector can dial
 * through — a pasted token, a GitHub App installation, a Figma grant — with
 * the connectors that use it. A token rotates in place (same account only);
 * a connection still in use cannot be deleted, and the row says why.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery } from '@tanstack/vue-query'
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-vue-next'
import type { ConnectionSummary, ListConnectionsResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import AiEmptyState from '@/components/ai/AiEmptyState.vue'
import { PageState } from '@/components/layout/page'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { providerMeta } from '@/lib/connection-providers'
import ConnectDialog from './ConnectDialog.vue'
import ConnectionAccount from './ConnectionAccount.vue'

defineProps<{ canManage: boolean }>()

const { t } = useI18n()
const workspaceId = getWorkspaceId()

const query = useQuery(apiQueryOptions('/v1/connections', { query: { workspaceId } }))
const data = computed(() => query.data.value as ListConnectionsResponse | undefined)
const connections = computed(() => data.value?.connections ?? [])

const invalidates = () => [['/v1/connections'], ['/v1/connectors']]
const remove = useApiMutation('delete', '/v1/connections/{id}', { invalidates })
const rotate = useApiMutation('patch', '/v1/connections/{id}', { invalidates })

const adding = ref(false)

async function confirmRemove(connection: ConnectionSummary) {
  const ok = await confirm({
    title: t('connectors.connections.deleteTitle'),
    description: t('connectors.connections.deleteBody', { account: accountName(connection) }),
    action: t('common.delete'),
    destructive: true,
  })
  if (!ok) return
  try {
    await remove.mutateAsync({ path: { id: connection.id } })
    toast.success(t('connectors.connections.deleted'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

function accountName(connection: ConnectionSummary): string {
  return connection.accountLabel ?? connection.credentialHint ?? providerLabel(connection)
}
function providerLabel(connection: ConnectionSummary): string {
  return providerMeta(connection.provider).label ?? t('connectors.connections.providers.git')
}

// --- rotate ---

const rotating = ref<ConnectionSummary | null>(null)
const secret = ref('')
const rotateError = ref<string | null>(null)

function openRotate(connection: ConnectionSummary) {
  rotating.value = connection
  secret.value = ''
  rotateError.value = null
}

async function submitRotate() {
  if (!rotating.value || !secret.value.trim()) return
  rotateError.value = null
  try {
    await rotate.mutateAsync({ path: { id: rotating.value.id }, body: { credential: secret.value.trim() } })
    toast.success(t('connectors.connections.rotated', { count: rotating.value.connectors.length }, rotating.value.connectors.length))
    rotating.value = null
  } catch (e) {
    // The provider's own refusal, or "another account": both are about what was pasted, so they stay by the field.
    rotateError.value = errorMessage(e, t)
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground max-w-prose text-sm">{{ t('connectors.connections.intro') }}</p>
      <Button v-if="canManage && connections.length" size="sm" @click="adding = true">
        <Plus class="size-3.5" /> {{ t('connectors.connections.add') }}
      </Button>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 2" :key="i" class="h-16 w-full" />
    </div>

    <PageState v-else-if="query.isError.value" state="error" :error="query.error.value">
      <template #actions>
        <Button size="sm" variant="outline" @click="query.refetch()">{{ t('common.retry') }}</Button>
      </template>
    </PageState>

    <AiEmptyState
      v-else-if="!connections.length"
      :icon="KeyRound"
      :title="t('connectors.connections.emptyTitle')"
      :body="t('connectors.connections.emptyBody')"
    >
      <template #action>
        <Button v-if="canManage" size="sm" @click="adding = true">
          <Plus class="size-3.5" /> {{ t('connectors.connections.add') }}
        </Button>
        <p v-else class="text-muted-foreground text-xs">{{ t('connectors.emptyNotAdmin') }}</p>
      </template>
    </AiEmptyState>

    <ul v-else class="divide-y rounded-lg border">
      <li v-for="connection in connections" :key="connection.id" class="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 sm:px-4">
        <ConnectionAccount :connection="connection" class="min-w-0 flex-1 basis-64" />

        <!-- Who would be stranded by a delete: named, and each one a link. -->
        <details v-if="connection.connectors.length" class="text-muted-foreground min-w-0 text-xs">
          <summary class="hover:text-foreground cursor-pointer select-none">
            {{ t('connectors.connections.usedBy', { count: connection.connectors.length }, connection.connectors.length) }}
          </summary>
          <ul class="mt-1.5 space-y-0.5">
            <li v-for="c in connection.connectors" :key="c.id" class="truncate">
              <RouterLink :to="`/settings/connectors/${c.id}`" class="hover:text-foreground underline-offset-2 hover:underline">
                {{ c.name }}
              </RouterLink>
            </li>
          </ul>
        </details>
        <span v-else class="text-muted-foreground text-xs">{{ t('connectors.connections.unused') }}</span>

        <span class="text-muted-foreground hidden text-xs md:inline" :title="connection.updatedAt">
          {{ relativeTime(connection.updatedAt) }}
        </span>

        <div v-if="canManage" class="ms-auto flex items-center gap-1">
          <Button v-if="connection.method === 'token'" size="sm" variant="ghost" @click="openRotate(connection)">
            {{ t('connectors.connections.rotate') }}
          </Button>
          <TooltipProvider v-if="connection.connectors.length" :delay-duration="200">
            <Tooltip>
              <TooltipTrigger as-child>
                <!-- Focusable while disabled, so keyboard users reach the reason too. -->
                <span tabindex="0" class="inline-flex rounded-md">
                  <Button size="sm" variant="ghost" disabled :aria-label="t('common.deleteNamed', { name: accountName(connection) })">
                    <Trash2 class="size-3.5" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{{ t('connectors.connections.inUse') }}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Button
            v-else
            size="sm"
            variant="ghost"
            :aria-label="t('common.deleteNamed', { name: accountName(connection) })"
            @click="confirmRemove(connection)"
          >
            <Trash2 class="text-destructive size-3.5" />
          </Button>
        </div>
      </li>
    </ul>

    <Dialog :open="rotating !== null" @update:open="(v: boolean) => !v && (rotating = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('connectors.connections.rotateTitle', { account: rotating ? accountName(rotating) : '' }) }}</DialogTitle>
          <DialogDescription>
            {{ t('connectors.connections.rotateBody', { count: rotating?.connectors.length ?? 0 }, rotating?.connectors.length ?? 0) }}
          </DialogDescription>
        </DialogHeader>
        <form class="space-y-3" @submit.prevent="submitRotate">
          <label class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.connections.newToken') }}</span>
            <Input
              v-model="secret"
              type="password"
              autocomplete="off"
              :placeholder="rotating?.credentialHint ? t('connectors.credentialKeep', { hint: rotating.credentialHint }) : ''"
              :aria-invalid="rotateError ? 'true' : undefined"
              aria-describedby="rotate-error"
            />
          </label>
          <p v-if="rotateError" id="rotate-error" class="text-destructive text-xs" role="alert">{{ rotateError }}</p>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="ghost" @click="rotating = null">{{ t('common.cancel') }}</Button>
            <Button type="submit" :disabled="!secret.trim() || rotate.isPending.value">
              <Loader2 v-if="rotate.isPending.value" class="size-4 animate-spin" aria-hidden="true" />
              {{ t('connectors.connections.rotateSave') }}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>

    <ConnectDialog v-model:open="adding" :methods="data?.methods ?? { app: false, oauth: false }" :can-store-secrets="data?.canStoreSecrets ?? false" :connections="connections" />
  </div>
</template>
