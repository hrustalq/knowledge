<script setup lang="ts">
/**
 * What GitHub has granted this connector, and how to change it
 * (docs/features/36).
 *
 * Three things a person fixing a GitHub problem needs in one place: the
 * installation's permissions and events beside what the App asks for and what
 * this connector's features need; which GitHub account they are linked as; and
 * the two doors out — the installation's page on GitHub, where an owner accepts
 * new permissions, and GitHub's authorisation page, to re-link or switch
 * accounts.
 *
 * Both doors open a new tab and refetch when this one regains focus, the
 * picker's rule: coming back is the moment the answer may have changed.
 *
 * Collapsible, like a rail widget: open by default only while something this
 * connector uses is missing or pending, because a healthy grant list is a
 * screenful nobody needs to read. Folded, the header still says which of the
 * two it is. A reader's own choice is remembered for the session, per the
 * layout store's rail rule.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery } from '@tanstack/vue-query'
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  Github,
  RefreshCw,
} from 'lucide-vue-next'
import type {
  ConnectorGithubAccessResponse,
  GithubAccessPurpose,
  GithubGrantStatus,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { Collapse } from '@/components/ui/collapse'
import { Skeleton } from '@/components/ui/skeleton'
import { labelFor } from '@/lib/labels'
import { useLayoutStore } from '@/stores/layout'

const props = defineProps<{ connectorId: string }>()
const { t } = useI18n()

const query = useQuery(
  computed(() => apiQueryOptions('/v1/connectors/{id}/github', { path: { id: props.connectorId } })),
)
const access = computed(() => query.data.value as ConnectorGithubAccessResponse | undefined)

const disconnect = useApiMutation('delete', '/v1/connectors/github/identity', {
  invalidates: () => [['/v1/connectors/{id}/github'], ['/v1/connectors/github/installations']],
})

/** Problems in a purpose this connector uses — what the header counts. */
const problems = computed(
  () =>
    [...(access.value?.permissions ?? []), ...(access.value?.events ?? [])].filter(
      (r) => r.active && (r.status === 'missing' || r.status === 'pending'),
    ).length,
)
const anyPending = computed(() =>
  [...(access.value?.permissions ?? []), ...(access.value?.events ?? [])].some((r) => r.active && r.status === 'pending'),
)
const anyMissing = computed(() =>
  [...(access.value?.permissions ?? []), ...(access.value?.events ?? [])].some((r) => r.active && r.status === 'missing'),
)

const layout = useLayoutStore()
const RAIL_SURFACE = 'connector'
const WIDGET = 'github-access'

const open = computed(() => {
  const remembered = layout.openWidgets(RAIL_SURFACE)
  return remembered ? remembered.includes(WIDGET) : problems.value > 0
})

function toggle() {
  const current = layout.openWidgets(RAIL_SURFACE) ?? (open.value ? [WIDGET] : [])
  layout.setWidgetOpen(RAIL_SURFACE, WIDGET, !open.value, current)
}

/** The one line a folded card carries: what is wrong, or whose installation it is. */
const preview = computed(() => {
  if (!access.value?.configured) return null
  if (problems.value) return t('connectors.githubAccess.problems', { count: problems.value })
  return access.value.installation?.accountLogin ?? (access.value.identity ? `@${access.value.identity.login}` : null)
})

const STATUS_ICON: Record<GithubGrantStatus, typeof CircleCheck> = {
  granted: CircleCheck,
  pending: CircleDashed,
  missing: CircleX,
  extra: CircleCheck,
}

/** A gap in something this connector does not use is shown, never alarmed about. */
function statusClass(status: GithubGrantStatus, active: boolean): string {
  if (status === 'granted') return 'text-emerald-600 dark:text-emerald-500'
  if (status === 'extra' || !active) return 'text-muted-foreground'
  return status === 'pending' ? 'text-amber-600 dark:text-amber-500' : 'text-destructive'
}

function purposes(list: GithubAccessPurpose[]): string {
  return list.map((p) => t(`connectors.githubAccess.purpose.${p}`)).join(', ')
}

function openAndWatch(url: string | null | undefined) {
  if (!url) return
  window.open(url, '_blank', 'noopener')
  const refetch = () => {
    void query.refetch()
    window.removeEventListener('focus', refetch)
  }
  window.addEventListener('focus', refetch)
}

async function forget() {
  try {
    await disconnect.mutateAsync({})
    toast.success(t('connectors.githubAccess.disconnected'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <section class="overflow-hidden rounded-lg border">
    <div class="flex items-center">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left transition-colors hover:bg-muted/50"
        :aria-expanded="open"
        @click="toggle"
      >
        <ChevronRight
          class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150"
          :class="open ? 'rotate-90' : ''"
        />
        <Github class="size-4 shrink-0" />
        <h2 class="shrink-0 text-sm font-medium">{{ t('connectors.githubAccess.title') }}</h2>
        <span
          v-if="!open && preview"
          class="ml-auto truncate pl-2 text-xs"
          :class="problems ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'"
        >
          {{ preview }}
        </span>
      </button>
      <button
        type="button"
        class="mr-3 shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
        :aria-label="t('connectors.github.refresh')"
        @click="query.refetch()"
      >
        <RefreshCw class="size-3.5" :class="query.isFetching.value && 'animate-spin'" />
      </button>
    </div>

    <Collapse :open="open">
    <div class="px-4 pb-4">
    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton class="h-4 w-40" />
      <Skeleton class="h-20 w-full" />
    </div>

    <p v-else-if="!access?.configured" class="text-muted-foreground text-xs">
      {{ t('connectors.githubAccess.notConfigured') }}
    </p>

    <div v-else class="space-y-4 text-sm">
      <!-- The installation this connector authenticates as. -->
      <section v-if="access.installation" class="space-y-1">
        <p class="flex items-center gap-1.5">
          <img
            v-if="access.installation.accountAvatarUrl"
            :src="access.installation.accountAvatarUrl"
            alt=""
            class="size-4 rounded-full"
            loading="lazy"
          />
          <span class="font-medium">{{ access.installation.accountLogin }}</span>
          <span class="text-muted-foreground text-xs">
            · {{ t(`connectors.githubAccess.selection.${access.installation.repositorySelection}`) }}
          </span>
        </p>
        <p v-if="access.installation.suspended" class="text-destructive text-xs">
          {{ t('connectors.githubAccess.suspended') }}
        </p>
      </section>
      <p v-else-if="access.auth === 'token'" class="text-muted-foreground text-xs">
        {{ t('connectors.githubAccess.usesToken') }}
      </p>
      <p v-else-if="access.auth === 'none'" class="text-muted-foreground text-xs">
        {{ t('connectors.githubAccess.noCredential') }}
      </p>

      <p v-if="access.error" class="text-destructive flex gap-1.5 text-xs">
        <CircleAlert class="mt-0.5 size-3.5 shrink-0" /> {{ access.error }}
      </p>

      <!-- Granted permissions, problems first. -->
      <section v-if="access.permissions.length" class="space-y-1.5">
        <h3 class="text-muted-foreground flex items-center justify-between text-xs font-medium uppercase">
          {{ t('connectors.githubAccess.permissions') }}
          <span v-if="problems" class="text-amber-600 normal-case dark:text-amber-500">
            {{ t('connectors.githubAccess.problems', { count: problems }) }}
          </span>
        </h3>
        <ul class="space-y-1">
          <li v-for="row in access.permissions" :key="row.name" class="flex items-start gap-2 text-xs">
            <component
              :is="STATUS_ICON[row.status]"
              class="mt-px size-3.5 shrink-0"
              :class="statusClass(row.status, row.active)"
            />
            <div class="min-w-0 flex-1">
              <div class="flex justify-between gap-2">
                <span>{{ labelFor(t, 'connectors.githubAccess.permission', row.name) }}</span>
                <span class="text-muted-foreground shrink-0">
                  {{ row.granted ? t(`connectors.githubAccess.level.${row.granted}`) : t('connectors.githubAccess.none') }}
                </span>
              </div>
              <p
                v-if="row.status === 'pending' || row.status === 'missing'"
                class="text-muted-foreground"
              >
                {{
                  t(`connectors.githubAccess.status.${row.status}`, {
                    level: t(`connectors.githubAccess.level.${row.needed}`),
                  })
                }}
              </p>
              <p v-if="row.purposes.length" class="text-muted-foreground/80">{{ purposes(row.purposes) }}</p>
            </div>
          </li>
        </ul>
      </section>

      <!-- Webhook events the installation delivers. -->
      <section v-if="access.events.length" class="space-y-1.5">
        <h3 class="text-muted-foreground text-xs font-medium uppercase">{{ t('connectors.githubAccess.events') }}</h3>
        <ul class="flex flex-wrap gap-1.5">
          <li
            v-for="row in access.events"
            :key="row.name"
            class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
            :title="
              [row.purposes.length ? purposes(row.purposes) : '', row.status === 'granted' || row.status === 'extra' ? '' : t(`connectors.githubAccess.eventStatus.${row.status}`)]
                .filter(Boolean)
                .join(' — ')
            "
          >
            <component :is="STATUS_ICON[row.status]" class="size-3" :class="statusClass(row.status, row.active)" />
            {{ row.name }}
          </li>
        </ul>
      </section>

      <!-- The ways to fix what the lists above say. -->
      <section v-if="access.installation" class="space-y-1.5">
        <p v-if="anyPending" class="text-muted-foreground text-xs">{{ t('connectors.githubAccess.pendingHint') }}</p>
        <p v-if="anyMissing" class="text-muted-foreground text-xs">{{ t('connectors.githubAccess.missingHint') }}</p>
        <div class="flex flex-wrap gap-2">
          <Button
            v-if="access.installation.settingsUrl"
            size="sm"
            variant="outline"
            @click="openAndWatch(access.installation.settingsUrl)"
          >
            <ExternalLink class="size-3.5" /> {{ t('connectors.githubAccess.reviewInstallation') }}
          </Button>
          <Button v-if="anyMissing && access.appSettingsUrl" size="sm" variant="outline" @click="openAndWatch(access.appSettingsUrl)">
            <ExternalLink class="size-3.5" /> {{ t('connectors.githubAccess.editApp') }}
          </Button>
        </div>
      </section>

      <!-- The viewer's own GitHub identity: what the repository picker browses as. -->
      <section class="space-y-1.5 border-t pt-3">
        <h3 class="text-muted-foreground text-xs font-medium uppercase">{{ t('connectors.githubAccess.account') }}</h3>
        <p v-if="access.identity" class="flex items-center gap-1.5 text-xs">
          <img v-if="access.identity.avatarUrl" :src="access.identity.avatarUrl" alt="" class="size-4 rounded-full" loading="lazy" />
          <span class="font-medium">@{{ access.identity.login }}</span>
          <span v-if="!access.identity.usable" class="text-amber-600 dark:text-amber-500">
            · {{ t('connectors.githubAccess.expired') }}
          </span>
        </p>
        <p v-else class="text-muted-foreground text-xs">{{ t('connectors.githubAccess.notLinked') }}</p>
        <p class="text-muted-foreground text-xs">{{ t('connectors.githubAccess.accountHint') }}</p>
        <div class="flex flex-wrap gap-2">
          <Button v-if="access.reconnectUrl" size="sm" variant="outline" @click="openAndWatch(access.reconnectUrl)">
            <Github class="size-3.5" />
            {{ access.identity ? t('connectors.githubAccess.reconnect') : t('connectors.github.connect') }}
          </Button>
          <Button
            v-if="access.identity"
            size="sm"
            variant="ghost"
            :disabled="disconnect.isPending.value"
            @click="forget"
          >
            {{ t('connectors.githubAccess.disconnect') }}
          </Button>
        </div>
      </section>
    </div>
    </div>
    </Collapse>
  </section>
</template>
