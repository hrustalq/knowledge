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
import { Check, Copy, Link2, Lock, Share2 } from 'lucide-vue-next'
import {
  SHARE_EXPIRY_PRESETS,
  SHARE_PASSWORD_MIN_CHARS,
  shareExpiryFor,
  shareNeedsPassword,
  type CreateShareLinkResponse,
  type ShareExpiryPreset,
  type ShareLinkListResponse,
} from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage, errorReason } from '@/shared/api/errors'
import { formatDate } from '@/shared/utils/format'
import { useCopy } from '@/shared/composables/use-copy'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Input } from '@/shared/ui/input'
import { ResponsivePopover } from '@/shared/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'

const props = defineProps<{
  documentId: string
  /**
   * The page is not open to the whole workspace (#76). A public link would
   * hand it to anyone, so the API refuses one (409 `share.restricted`) and
   * the form is not offered; links made before the restriction stay listed
   * so they can still be revoked.
   */
  restricted?: boolean
  /** Icon-only, for a crowded header — WatchButton's `compact`. */
  compact?: boolean
}>()

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
const allowDownload = ref(false)
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
    const res = await api.post('/v1/documents/{id}/shares', {
      path: { id: props.documentId },
      body: {
        includeSubtree: includeSubtree.value,
        allowDownload: allowDownload.value,
        expiresAt: shareExpiryFor(expiry.value)?.toISOString() ?? null,
        ...(password.value ? { password: password.value } : {}),
      },
    })
    created.value = res
    password.value = ''
    await copy(res.url)
    toast.success(copyState.value === 'copied' ? t('share.linkCopied') : t('share.created'))
    void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
  } catch (e) {
    // The page was restricted after this panel loaded: say what to do instead.
    toast.error(errorReason(e) === 'share.restricted' ? t('access.shareRestricted') : errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

/** Takes effect on the next request: a reader's finished file stops downloading once it is off (#161). */
async function setDownload(id: string, on: boolean) {
  try {
    await api.patch('/v1/shares/{id}', { path: { id }, body: { allowDownload: on } })
    toast.success(on ? t('share.downloadOn') : t('share.downloadOff'))
    void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t) || t('share.failed'))
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
      <Button
        :variant="compact ? 'ghost' : 'outline'"
        :size="compact ? 'icon-sm' : 'sm'"
        :title="t('share.button')"
        :aria-label="compact ? t('share.button') : undefined"
      >
        <Share2 :class="compact ? 'size-4' : 'size-3.5'" />
        <span v-if="!compact" class="kn-bar-label">{{ t('share.button') }}</span>
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
        <p v-if="restricted" class="flex items-start gap-2">
          <Lock class="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {{ t('access.shareRestricted') }}
        </p>
        <p v-else class="text-muted-foreground">{{ t('share.intro') }}</p>

        <!-- The link just made. When the server keeps no copy, this is the only time it is shown. -->
        <div v-if="created" class="space-y-1.5 rounded-md border bg-muted/40 p-2.5">
          <div class="flex items-center gap-2">
            <Input :model-value="created.url" readonly class="h-8 font-mono text-xs" :aria-label="t('share.copyLink')" />
            <Button size="icon-sm" variant="outline" :aria-label="t('share.copyLink')" @click="copyLink(created.url)">
              <Check v-if="copyState === 'copied'" class="size-3.5" />
              <Copy v-else class="size-3.5" />
            </Button>
          </div>
          <p v-if="!created.share.url" class="text-xs text-panel-warning-ink">{{ t('share.shownOnce') }}</p>
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

        <form v-if="!restricted" class="space-y-3" @submit.prevent="create">
          <label class="flex items-center gap-2">
            <Checkbox v-model="includeSubtree" />
            <span>{{ t('share.includeSubtree') }}</span>
          </label>
          <label class="flex items-center gap-2">
            <Checkbox v-model="allowDownload" />
            <span>{{ t('share.allowDownload') }}</span>
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
                <label class="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox :model-value="s.allowDownload" @update:model-value="(on) => setDownload(s.id, on === true)" />
                  {{ t('share.downloadToggle') }}
                </label>
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
