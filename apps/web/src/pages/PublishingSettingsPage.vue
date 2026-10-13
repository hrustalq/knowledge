<script setup lang="ts">
/**
 * /settings/publishing (docs/features/43, 44, issue #77): what this workspace
 * may show to people who are not signed in — share links and published sites
 * — and every public link it has made.
 *
 * Each switch shows what is asked for (the override; "default" inherits off)
 * beside what applies — and when the deployment's PUBLIC_SHARING_ENABLED or
 * PUBLIC_SITES_ENABLED ceiling is off, says so, because a switch that reads "on" while nothing
 * works is a silent clamp (CLAUDE.md). Admin-only, like the routes behind it.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type {
  PublishingSettingsOverride,
  PublishingSettingsResponse,
  ShareLinkSummary,
  WorkspaceShareLinksResponse,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageState } from '@/components/layout/page'

const { t } = useI18n()
const auth = useAuthStore()
const queryClient = useQueryClient()
const workspaceId = getWorkspaceId()
const canManage = computed(() => auth.canAdminWorkspace)

const settingsOptions = apiQueryOptions('/v1/workspaces/{id}/publishing-settings', { path: { id: workspaceId } })
const settingsQuery = useQuery({ ...settingsOptions, enabled: canManage })
const settings = computed(() => settingsQuery.data.value as PublishingSettingsResponse | undefined)

const inventoryOptions = apiQueryOptions('/v1/workspaces/{id}/shares', { path: { id: workspaceId } })
const inventoryQuery = useQuery({ ...inventoryOptions, enabled: canManage })
const shares = computed(() => (inventoryQuery.data.value as WorkspaceShareLinksResponse | undefined)?.shares ?? [])

type Tri = 'inherit' | 'on' | 'off'
type Key = keyof PublishingSettingsOverride
const KEYS: readonly { key: Key; label: string; hint: string }[] = [
  { key: 'allowShareLinks', label: 'publishing.allowShareLinks', hint: 'publishing.allowShareLinksHint' },
  { key: 'allowPasswordlessShares', label: 'publishing.allowPasswordless', hint: 'publishing.allowPasswordlessHint' },
  { key: 'allowPublicSites', label: 'publishing.allowPublicSites', hint: 'publishing.allowPublicSitesHint' },
]

const form = reactive<Record<Key, Tri>>({
  allowShareLinks: 'inherit',
  allowPasswordlessShares: 'inherit',
  allowPublicSites: 'inherit',
})
const toTri = (v: boolean | null): Tri => (v === null ? 'inherit' : v ? 'on' : 'off')
const fromTri = (v: Tri): boolean | null => (v === 'inherit' ? null : v === 'on')
watch(
  settings,
  (res) => {
    if (!res) return
    for (const { key } of KEYS) form[key] = toTri(res.override[key])
  },
  { immediate: true },
)
const dirty = computed(() => !!settings.value && KEYS.some(({ key }) => fromTri(form[key]) !== settings.value!.override[key]))

const saving = ref(false)
async function save() {
  if (saving.value || !dirty.value) return
  saving.value = true
  try {
    const next = (await api.patch('/v1/workspaces/{id}/publishing-settings', {
      path: { id: workspaceId },
      body: {
        allowShareLinks: fromTri(form.allowShareLinks),
        allowPasswordlessShares: fromTri(form.allowPasswordlessShares),
        allowPublicSites: fromTri(form.allowPublicSites),
      },
    })) as PublishingSettingsResponse
    queryClient.setQueryData(settingsOptions.queryKey, next)
    toast.success(t('publishing.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

function statusOf(s: ShareLinkSummary): 'active' | 'expired' | 'revoked' {
  if (s.revokedAt) return 'revoked'
  if (s.expiresAt && Date.parse(s.expiresAt) <= Date.now()) return 'expired'
  return 'active'
}

async function revoke(id: string) {
  try {
    await api.delete('/v1/shares/{id}', { path: { id } })
    toast.success(t('share.revoked'))
    void queryClient.invalidateQueries({ queryKey: inventoryOptions.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-6">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('publishing.title') }}</h1>
      <p class="text-muted-foreground mt-0.5 text-sm">{{ t('publishing.subtitle') }}</p>
    </div>

    <p v-if="!canManage" class="text-sm text-muted-foreground">{{ t('publishing.adminOnly') }}</p>

    <template v-else>
      <PageState v-if="settingsQuery.isPending.value" state="loading" :rows="2" row-class="h-14" />
      <PageState v-else-if="settingsQuery.isError.value" state="error" :error="settingsQuery.error.value" />

      <form v-else-if="settings" class="max-w-2xl space-y-3" @submit.prevent="save">
        <p
          v-if="!settings.ceiling.sharingEnabled"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
        >
          {{ t('publishing.ceilingOff') }}
        </p>
        <p
          v-if="!settings.ceiling.sitesEnabled"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
        >
          {{ t('publishing.sitesCeilingOff') }}
        </p>
        <div class="divide-y rounded-md border">
          <div v-for="k in KEYS" :key="k.key" class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
            <div class="min-w-0">
              <span class="text-sm font-medium">{{ t(k.label) }}</span>
              <p class="text-xs text-muted-foreground">{{ t(k.hint) }}</p>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ t('publishing.applies', { value: settings.effective[k.key] ? t('publishing.on') : t('publishing.off') }) }}
              </p>
            </div>
            <Select v-model="form[k.key]">
              <SelectTrigger class="h-9 w-full" :aria-label="t(k.label)"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">{{ t('publishing.inherit') }}</SelectItem>
                <SelectItem value="on">{{ t('publishing.on') }}</SelectItem>
                <SelectItem value="off">{{ t('publishing.off') }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <p v-if="settings.ceiling.maxTtlDays" class="text-xs text-muted-foreground">
          {{ t('publishing.maxTtl', { days: settings.ceiling.maxTtlDays }) }}
        </p>
        <Button type="submit" size="sm" :disabled="!dirty || saving">{{ saving ? t('common.saving') : t('common.save') }}</Button>
      </form>

      <section class="space-y-2">
        <h2 class="text-base font-semibold">{{ t('publishing.inventory') }}</h2>
        <PageState v-if="inventoryQuery.isPending.value" state="loading" :rows="3" row-class="h-10" />
        <p v-else-if="!shares.length" class="text-sm text-muted-foreground">{{ t('publishing.inventoryEmpty') }}</p>
        <div v-else class="overflow-x-auto rounded-md border">
          <table class="w-full text-sm">
            <thead class="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th class="px-3 py-2 font-medium">{{ t('publishing.colPage') }}</th>
                <th class="px-3 py-2 font-medium">{{ t('publishing.colStatus') }}</th>
                <th class="px-3 py-2 font-medium">{{ t('publishing.colExpires') }}</th>
                <th class="px-3 py-2 font-medium">{{ t('publishing.colCreated') }}</th>
                <th class="px-3 py-2" />
              </tr>
            </thead>
            <tbody class="divide-y">
              <tr v-for="s in shares" :key="s.id">
                <td class="px-3 py-2">
                  <RouterLink :to="`/documents/${s.documentId}`" class="hover:underline">{{ s.documentTitle }}</RouterLink>
                  <span class="ml-2 inline-flex gap-1">
                    <Badge v-if="s.includeSubtree" variant="outline">{{ t('share.withSubpages') }}</Badge>
                    <Badge v-if="s.hasPassword" variant="outline">{{ t('share.withPassword') }}</Badge>
                  </span>
                </td>
                <td class="px-3 py-2">
                  <Badge :variant="statusOf(s) === 'active' ? 'default' : 'secondary'">{{ t(`publishing.status.${statusOf(s)}`) }}</Badge>
                </td>
                <td class="px-3 py-2 text-muted-foreground">{{ s.expiresAt ? formatDate(s.expiresAt) : t('share.neverExpires') }}</td>
                <td class="px-3 py-2 text-muted-foreground">{{ formatDate(s.createdAt) }}</td>
                <td class="px-3 py-2 text-right">
                  <Button
                    v-if="statusOf(s) === 'active'"
                    size="sm"
                    variant="ghost"
                    class="h-7 text-destructive hover:text-destructive"
                    @click="revoke(s.id)"
                  >
                    {{ t('share.revoke') }}
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
