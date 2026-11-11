<script setup lang="ts">
/**
 * Your connected accounts (#857): every sign-in and pasted token that is
 * yours, the workspaces whose connections dial with each, and the two things
 * only the owner can do — rotate it once for all of them, and disconnect it.
 * A disconnect is refused while any workspace still uses it, and the row
 * names where, as a connection in use does. Connecting happens in a
 * workspace's connect dialog, so there is no "add" here.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Trash2 } from 'lucide-vue-next'
import type { CredentialSummary, CredentialsResponse } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@knowledge/ui/button'
import { confirm } from '@knowledge/ui/confirm'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@knowledge/ui/tooltip'
import { ConnectionAccount, TokenDialog, providerMeta } from '@/entities/connector'

const { t } = useI18n()
const queryClient = useQueryClient()
const options = apiQueryOptions('/v1/me/credentials')
const query = useQuery(options)
const credentials = computed(() => (query.data.value as CredentialsResponse | undefined)?.credentials ?? [])
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: options.queryKey })
  void queryClient.invalidateQueries({ queryKey: ['/v1/connections'] })
}

const nameOf = (c: CredentialSummary) =>
  c.accountLabel ?? c.secretHint ?? providerMeta(c.provider).label ?? t('connectors.connections.providers.git')
const workspacesOf = (c: CredentialSummary) => [...new Set(c.usedBy.map((u) => u.workspaceName))]
const connectorCount = (c: CredentialSummary) => c.usedBy.reduce((n, u) => n + u.connectors.length, 0)

async function disconnect(c: CredentialSummary) {
  const ok = await confirm({
    title: t('profileSettings.accounts.disconnectTitle'),
    description: t('profileSettings.accounts.disconnectBody', { account: nameOf(c) }),
    action: t('profileSettings.accounts.disconnect'),
    destructive: true,
  })
  if (!ok) return
  try {
    await api.delete('/v1/me/credentials/{id}', { path: { id: c.id } })
    toast.success(t('profileSettings.accounts.disconnected'))
    refresh()
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

const rotating = ref<CredentialSummary | null>(null)
const rotateError = ref<string | null>(null)
const rotatePending = ref(false)
function openRotate(c: CredentialSummary) {
  rotating.value = c
  rotateError.value = null
}
async function submitRotate(secret: string) {
  if (!rotating.value) return
  rotatePending.value = true
  rotateError.value = null
  try {
    await api.patch('/v1/me/credentials/{id}', { path: { id: rotating.value.id }, body: { credential: secret } })
    toast.success(t('profileSettings.accounts.rotated'))
    rotating.value = null
    refresh()
  } catch (e) {
    rotateError.value = errorMessage(e, t)
  } finally {
    rotatePending.value = false
  }
}
</script>

<template>
  <div class="min-w-0">
    <h3 class="text-sm font-medium">{{ t('profileSettings.accounts.title') }}</h3>
    <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.accounts.hint') }}</p>
  </div>
  <ul v-if="credentials.length" class="mt-3 divide-y rounded-lg border">
    <li v-for="c in credentials" :key="c.id" class="flex flex-wrap items-center gap-x-3 gap-y-2 p-2.5 sm:px-3">
      <div class="min-w-0 flex-1 basis-72">
        <ConnectionAccount :connection="{ ...c, credentialHint: c.secretHint }" />
        <p class="mt-1 truncate ps-11 text-xs text-muted-foreground" :title="workspacesOf(c).join(', ')">
          <template v-if="!c.bindable">{{ t('profileSettings.accounts.browseOnly') }}</template>
          <template v-else-if="c.usedBy.length">
            {{ t('profileSettings.accounts.usedIn', { workspaces: workspacesOf(c).join(', '), count: connectorCount(c) }, connectorCount(c)) }}
          </template>
          <template v-else>{{ t('profileSettings.accounts.unused') }}</template>
        </p>
      </div>
      <div class="ms-auto flex items-center gap-1">
        <Button v-if="c.method === 'token'" size="sm" variant="ghost" @click="openRotate(c)">{{ t('profileSettings.accounts.rotate') }}</Button>
        <TooltipProvider v-if="c.usedBy.length" :delay-duration="200">
          <Tooltip>
            <TooltipTrigger as-child>
              <!-- Focusable while disabled, so keyboard users reach the reason too. -->
              <span tabindex="0" class="inline-flex rounded-md">
                <Button size="sm" variant="ghost" disabled :aria-label="t('profileSettings.accounts.disconnectNamed', { account: nameOf(c) })">
                  <Trash2 class="size-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{{ t('profileSettings.accounts.inUse', { workspaces: workspacesOf(c).join(', ') }) }}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Button v-else size="sm" variant="ghost" :aria-label="t('profileSettings.accounts.disconnectNamed', { account: nameOf(c) })" @click="disconnect(c)">
          <Trash2 class="text-destructive size-3.5" />
        </Button>
      </div>
    </li>
  </ul>
  <p v-else-if="query.isSuccess.value" class="mt-3 text-xs text-muted-foreground">{{ t('profileSettings.accounts.none') }}</p>

  <TokenDialog
    :open="rotating !== null"
    :title="t('connectors.connections.rotateTitle', { account: rotating ? nameOf(rotating) : '' })"
    :description="rotating ? t('profileSettings.accounts.rotateBody', { workspaces: workspacesOf(rotating).join(', ') }, workspacesOf(rotating).length) : ''"
    :submit-label="t('connectors.connections.rotateSave')"
    :hint="rotating?.secretHint"
    :pending="rotatePending"
    :error="rotateError"
    @update:open="(v: boolean) => !v && (rotating = null)"
    @submit="submitRotate"
  />
</template>
