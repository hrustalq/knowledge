<script setup lang="ts">
/**
 * Clone this project with git (#636, docs/features/71).
 *
 * Shown only when the workspace has the `git` feature on and the deployment
 * runs the remote (`GET /v1/projects/:id/git` answers a URL). The order is the
 * order of the work: the URL, a key, then the commands that use it.
 *
 * The key reaches git through a credential helper reading `KNOWLEDGE_API_KEY`,
 * never the URL or `.git/config` — SKILL.md's recipe, word for word. The empty
 * `credential.helper=` first clears git's own helpers: on a Mac, osxkeychain
 * otherwise answers with a key it stored earlier, and the clone comes back in
 * another person's view.
 *
 * A key minted here is shown once, like the Connect AI page's, and pinned to
 * this workspace. Listing and revoking keys stay on that page.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Check, Copy, FolderGit2, KeyRound } from 'lucide-vue-next'
import type { ApiKeyScope, ProjectGitResponse } from '@knowledge/contracts'
import { api, apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { useCopy } from '@/shared/composables/use-copy'
import { CopyBlock, KEY_ENV } from '@/entities/access'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { ResponsivePopover } from '@/shared/ui/popover'

const props = defineProps<{ projectId: string; projectName: string }>()

const { t } = useI18n()
const auth = useAuthStore()
const features = useFeaturesStore()
const { state: copyState, copy } = useCopy()

const gitQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/projects/{id}/git', { path: { id: props.projectId } }),
    // The route 404s with the feature off; a guest is refused by the remote anyway.
    enabled: features.isOn('git') && auth.canComment,
  })),
)
const url = computed(() => (gitQuery.data.value as ProjectGitResponse | undefined)?.url ?? null)

/** AUTH_MODE=none: the remote takes any caller, so there is no key to make. */
const needsKey = computed(() => !auth.isDev)
const busy = ref(false)
const fresh = ref<{ apiKey: string; scope: ApiKeyScope } | null>(null)

async function createKey(scope: ApiKeyScope) {
  if (busy.value) return
  busy.value = true
  try {
    const res = await api.post('/v1/me/api-keys', {
      body: { name: `git: ${props.projectName}`.slice(0, 80), scope, workspaceId: getWorkspaceId() },
    })
    fresh.value = { apiKey: res.apiKey, scope }
  } catch (e) {
    toast.error(errorMessage(e, t) || t('connect.keys.createFailed'))
  } finally {
    busy.value = false
  }
}

const commands = computed(() =>
  [
    ...(fresh.value ? [`export ${KEY_ENV}=${fresh.value.apiKey}`] : []),
    `helper='!f() { echo username=knowledge; echo "password=$${KEY_ENV}"; }; f'`,
    `git -c credential.helper= -c credential.helper="$helper" clone ${url.value}`,
    `git -C ${props.projectId} config credential.helper ''`,
    `git -C ${props.projectId} config --add credential.helper "$helper"`,
  ].join('\n'),
)

const PUSH_COMMAND = 'git push -o merge_request.create origin HEAD:<branch>'

/** Push needs edit rights, and a key that carries them when there is a key at all. */
const canPush = computed(() => auth.canEdit && (!needsKey.value || fresh.value?.scope !== 'read'))

function onOpen(next: boolean) {
  if (!next) fresh.value = null
}
</script>

<template>
  <ResponsivePopover
    v-if="url"
    :title="t('git.clone.title')"
    align="end"
    side="bottom"
    panel-class="w-[28rem] max-w-[calc(100vw-2rem)] p-4"
    @update:open="onOpen"
  >
    <template #trigger>
      <Button variant="outline" size="sm">
        <FolderGit2 class="size-3.5" /> {{ t('git.clone.button') }}
      </Button>
    </template>

    <div class="space-y-4 text-sm">
      <p class="text-muted-foreground">{{ t('git.clone.intro') }}</p>

      <div class="flex items-center gap-2">
        <Input :model-value="url" readonly class="h-8 font-mono text-xs" :aria-label="t('git.clone.url')" />
        <Button size="icon-sm" variant="outline" :aria-label="t('git.clone.copyUrl')" @click="copy(url!)">
          <Check v-if="copyState === 'copied'" class="size-3.5" />
          <Copy v-else class="size-3.5" />
        </Button>
      </div>

      <section v-if="needsKey" class="space-y-2" :aria-label="t('git.clone.keyTitle')">
        <p v-if="fresh" class="text-xs text-panel-warning-ink">{{ t('git.clone.shownOnce', { env: KEY_ENV }) }}</p>
        <template v-else>
          <p class="text-muted-foreground">
            <i18n-t keypath="git.clone.keyIntro" scope="global">
              <template #env><code class="font-mono text-xs">{{ KEY_ENV }}</code></template>
              <template #connect>
                <RouterLink to="/settings/ai/connect" class="text-primary hover:underline">{{ t('git.clone.connectLink') }}</RouterLink>
              </template>
            </i18n-t>
          </p>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" :disabled="busy" @click="createKey('read')">
              <KeyRound class="size-3.5" /> {{ t('git.clone.readKey') }}
            </Button>
            <Button v-if="auth.canEdit" size="sm" :disabled="busy" @click="createKey('write')">
              <KeyRound class="size-3.5" /> {{ t('git.clone.writeKey') }}
            </Button>
          </div>
        </template>
      </section>

      <CopyBlock :code="commands" :label="t('git.clone.terminal')" :secret="!!fresh" />

      <p v-if="canPush" class="text-xs text-muted-foreground">
        <i18n-t keypath="git.clone.pushHint" scope="global">
          <template #command>
            <code class="font-mono">{{ PUSH_COMMAND }}</code>
          </template>
        </i18n-t>
      </p>
    </div>
  </ResponsivePopover>
</template>
