<script setup lang="ts">
/**
 * Share a page publicly (docs/features/43, issue #77): create a read-only link,
 * copy it, revoke it.
 *
 * What it offers follows the workspace's resolved policy, which the list
 * answers with — so a workspace with sharing off gets an explanation instead
 * of a form that would only 403. The server is still the check: a never-
 * expiring link without a password is refused there too, and a TTL cap clamps
 * the expiry there and comes back as "asked for X, applies Y".
 *
 * SSR: the list is fetched only once the panel opens.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Check, Copy, Link2, Share2 } from 'lucide-vue-next'
import {
  SHARE_EXPIRY_PRESETS,
  SHARE_PASSWORD_MIN_CHARS,
  shareExpiryFor,
  shareNeedsPassword,
  type CreateShareLinkResponse,
  type ShareExpiryPreset,
  type ShareLinkListResponse,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { formatDate } from '@/lib/format'
import { useCopy } from '@/lib/use-copy'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ResponsivePopover } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const props = defineProps<{ documentId: string }>()

const { t } = useI18n()
const auth = useAuthStore()
const queryClient = useQueryClient()
const { state: copyState, copy } = useCopy()

const open = ref(false)
const options = computed(() => apiQueryOptions('/v1/documents/{id}/shares', { path: { id: props.documentId } }))
const query = useQuery(computed(() => ({ ...options.value, enabled: open.value })))
const data = computed(() => query.data.value as ShareLinkListResponse | undefined)
const policy = computed(() => data.value?.policy)

const includeSubtree = ref(false)
const expiry = ref<ShareExpiryPreset>('7d')
const password = ref('')
const busy = ref(false)
/** The link just created — shown with its copy button until the panel closes. */
const created = ref<CreateShareLinkResponse | null>(null)

const passwordTooShort = computed(() => password.value.length > 0 && password.value.length < SHARE_PASSWORD_MIN_CHARS)
const needsPassword = computed(
  () =>
    !!policy.value &&
    // Under a TTL cap "never" becomes the cap, which is an expiry.
    !policy.value.maxTtlDays &&
    shareNeedsPassword({ expiresAt: shareExpiryFor(expiry.value), hasPassword: password.value.length > 0 }, policy.value),
)

async function create() {
  if (busy.value || needsPassword.value || passwordTooShort.value) return
  busy.value = true
  try {
    const res = (await api.post('/v1/documents/{id}/shares', {
      path: { id: props.documentId },
      body: {
        includeSubtree: includeSubtree.value,
        expiresAt: shareExpiryFor(expiry.value)?.toISOString() ?? null,
        ...(password.value ? { password: password.value } : {}),
      },
    })) as CreateShareLinkResponse
    created.value = res
    password.value = ''
    await copy(res.url)
    toast.success(copyState.value === 'copied' ? t('share.linkCopied') : t('share.created'))
    void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

async function revoke(id: string) {
  try {
    await api.delete('/v1/shares/{id}', { path: { id } })
    if (created.value?.share.id === id) created.value = null
    toast.success(t('share.revoked'))
    void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t) || t('share.failed'))
  }
}

async function copyLink(url: string) {
  await copy(url)
  if (copyState.value === 'copied') toast.success(t('share.linkCopied'))
}

function onOpen(next: boolean) {
  if (!next) created.value = null
}
</script>

<template>
  <ResponsivePopover v-model:open="open" :title="t('share.title')" align="end" side="bottom" panel-class="w-96 p-4" @update:open="onOpen">
    <template #trigger>
      <Button variant="outline" size="sm">
        <Share2 class="size-3.5" />
        {{ t('share.button') }}
      </Button>
    </template>

    <div class="space-y-4 text-sm">
      <p v-if="query.isPending.value" class="text-muted-foreground">{{ t('common.loading') }}</p>

      <div v-else-if="policy && !policy.enabled" class="space-y-1">
        <p>{{ t('share.disabled') }}</p>
        <p class="text-muted-foreground">
          <RouterLink v-if="auth.canAdminWorkspace" to="/settings/publishing" class="text-primary hover:underline">
            {{ t('share.disabledAdmin') }}
          </RouterLink>
          <template v-else>{{ t('share.disabledAsk') }}</template>
        </p>
      </div>

      <template v-else-if="policy">
        <p class="text-muted-foreground">{{ t('share.intro') }}</p>

        <!-- The link just made. When the server keeps no copy, this is the only time it is shown. -->
        <div v-if="created" class="space-y-1.5 rounded-md border bg-muted/40 p-2.5">
          <div class="flex items-center gap-2">
            <Input :model-value="created.url" readonly class="h-8 font-mono text-xs" :aria-label="t('share.copyLink')" />
            <Button size="icon-sm" variant="outline" :aria-label="t('share.copyLink')" @click="copyLink(created.url)">
              <Check v-if="copyState === 'copied'" class="size-3.5" />
              <Copy v-else class="size-3.5" />
            </Button>
          </div>
          <p v-if="!created.share.url" class="text-xs text-amber-700 dark:text-amber-400">{{ t('share.shownOnce') }}</p>
          <p v-if="created.requestedExpiresAt && created.share.expiresAt" class="text-xs text-muted-foreground">
            {{
              t('share.clamped', {
                asked: formatDate(created.requestedExpiresAt),
                days: policy.maxTtlDays,
                applied: formatDate(created.share.expiresAt),
              })
            }}
          </p>
        </div>

        <form class="space-y-3" @submit.prevent="create">
          <label class="flex items-center gap-2">
            <Checkbox v-model="includeSubtree" />
            <span>{{ t('share.includeSubtree') }}</span>
          </label>
          <div class="grid grid-cols-[6rem_1fr] items-center gap-2">
            <span class="text-muted-foreground">{{ t('share.expiry') }}</span>
            <Select v-model="expiry">
              <SelectTrigger class="h-8 w-full" :aria-label="t('share.expiry')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in SHARE_EXPIRY_PRESETS" :key="p" :value="p">{{ t(`share.expiryPreset.${p}`) }}</SelectItem>
              </SelectContent>
            </Select>
            <label for="share-password" class="text-muted-foreground">{{ t('share.password') }}</label>
            <Input
              id="share-password"
              v-model="password"
              type="password"
              autocomplete="new-password"
              class="h-8"
              :placeholder="t('common.optional')"
              :aria-invalid="passwordTooShort || needsPassword || undefined"
              aria-describedby="share-password-hint"
            />
          </div>
          <p id="share-password-hint" class="text-xs" :class="needsPassword ? 'text-destructive' : 'text-muted-foreground'">
            {{ needsPassword ? t('share.passwordNeeded') : t('share.passwordHint', { n: SHARE_PASSWORD_MIN_CHARS }) }}
          </p>
          <Button type="submit" size="sm" class="w-full" :disabled="busy || needsPassword || passwordTooShort">
            <Link2 class="size-3.5" />
            {{ busy ? t('share.creating') : t('share.create') }}
          </Button>
        </form>

        <div class="space-y-2 border-t pt-3">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('share.active') }}</p>
          <p v-if="!data?.shares.length" class="text-muted-foreground">{{ t('share.none') }}</p>
          <ul v-else class="space-y-2">
            <li v-for="s in data.shares" :key="s.id" class="flex items-start gap-2">
              <div class="min-w-0 flex-1 space-y-1">
                <div class="flex flex-wrap items-center gap-1 text-xs">
                  <Badge v-if="s.includeSubtree" variant="outline">{{ t('share.withSubpages') }}</Badge>
                  <Badge v-if="s.hasPassword" variant="outline">{{ t('share.withPassword') }}</Badge>
                  <span class="text-muted-foreground">
                    {{ s.expiresAt ? t('share.expiresOn', { date: formatDate(s.expiresAt) }) : t('share.neverExpires') }}
                  </span>
                </div>
                <p v-if="!s.url" class="text-xs text-muted-foreground">{{ t('share.notCopyable') }}</p>
              </div>
              <Button v-if="s.url" size="icon-sm" variant="ghost" :aria-label="t('share.copyLink')" @click="copyLink(s.url)">
                <Copy class="size-3.5" />
              </Button>
              <Button size="sm" variant="ghost" class="h-7 text-destructive hover:text-destructive" @click="revoke(s.id)">
                {{ t('share.revoke') }}
              </Button>
            </li>
          </ul>
        </div>
      </template>
    </div>
  </ResponsivePopover>
</template>
