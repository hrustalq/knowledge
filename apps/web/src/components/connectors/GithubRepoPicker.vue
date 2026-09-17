<script setup lang="ts">
/**
 * The GitHub repository picker (docs/features/30).
 *
 * Replaces the Repository URL text box for `codebase` and `markdown-git` when a
 * GitHub App is configured. Three states, in the order a person meets them:
 * not connected (offer OAuth), connected with no installation (offer install),
 * connected with installations (switch account, search, pick).
 *
 * It writes three config keys and never reads any of them back into local
 * state, so the xstate machine stays the single source of truth and the
 * wizard's localStorage snapshot keeps working untouched:
 *
 *   repoUrl                — what every adapter already parses
 *   githubInstallationId   — what tells the API to mint a token per run
 *   branch                 — the repo's default, so the next step opens correct
 *
 * The two redirect buttons open a new tab rather than navigating: the wizard's
 * state lives in this tab, and sending it to github.com would mean relying on
 * the snapshot to restore work the person can simply keep.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Github, Loader2, Lock, Plus, RefreshCw } from 'lucide-vue-next'
import type { GithubInstallationsResponse, GithubReposResponse } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import Autocomplete, { type AutocompleteOption } from '@/components/ui/autocomplete/Autocomplete.vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  workspaceId: string
  /** The currently configured repository URL, so a resumed wizard shows its pick. */
  repoUrl: string
  installationId: string
}>()

const emit = defineEmits<{
  /** One event, because the three keys are one decision and must not half-apply. */
  pick: [{ repoUrl: string; installationId: string; defaultBranch: string }]
}>()

const { t } = useI18n()

const accounts = useQuery(
  apiQueryOptions('/v1/connectors/github/installations', {
    query: { workspaceId: props.workspaceId, returnTo: '/settings/connectors' },
  }),
)

const state = computed(() => accounts.data.value as GithubInstallationsResponse | undefined)
const installations = computed(() => state.value?.installations ?? [])

/**
 * Which account the list is showing. Seeded from the saved installation so a
 * resumed or edited connector opens on its own account rather than the first.
 */
const selected = ref<string>(props.installationId)
watch(
  installations,
  (list) => {
    if (list.length === 0) return
    if (!list.some((i) => i.installationId === selected.value)) {
      selected.value = props.installationId || list[0].installationId
    }
  },
  { immediate: true },
)

/** Full repo objects by `owner/name`, so picking can emit the default branch. */
const known = new Map<string, { htmlUrl: string; defaultBranch: string }>()

async function loadRepos(query: string): Promise<AutocompleteOption[]> {
  if (!selected.value) return []
  const res = (await api.get('/v1/connectors/github/repos', {
    query: { workspaceId: props.workspaceId, installationId: selected.value, q: query },
  })) as GithubReposResponse
  if (!res.ok) return []

  return res.repositories.map((repo) => {
    known.set(repo.fullName, { htmlUrl: repo.htmlUrl, defaultBranch: repo.defaultBranch })
    return {
      value: repo.fullName,
      label: repo.fullName,
      // The branch is the useful half: it is what the next step will default
      // to, and seeing `dev` here is what stops the #28 surprise happening at
      // sync time instead.
      meta: repo.private ? `${repo.defaultBranch} · ${t('connectors.github.private')}` : repo.defaultBranch,
    }
  })
}

/** Derived from repoUrl so this control has no opinion the machine does not hold. */
const picked = computed(() => {
  const match = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(props.repoUrl)
  return match ? [match[1]] : []
})

function choose(values: string[]) {
  const fullName = values[0]
  const repo = fullName ? known.get(fullName) : undefined
  if (!fullName || !repo) return
  emit('pick', {
    repoUrl: repo.htmlUrl,
    installationId: selected.value,
    defaultBranch: repo.defaultBranch,
  })
}

/**
 * Both redirects come back to this screen, so the list is refetched when the
 * tab regains focus rather than on a timer — a person who just installed the
 * App expects to see the new org without pressing anything.
 */
function openAndWatch(url: string | null) {
  if (!url) return
  window.open(url, '_blank', 'noopener')
  const refetch = () => {
    void accounts.refetch()
    window.removeEventListener('focus', refetch)
  }
  window.addEventListener('focus', refetch)
}
</script>

<template>
  <div class="space-y-3">
    <!-- Loading: one frame, rather than flashing "not configured" first. -->
    <div v-if="accounts.isPending.value" class="text-muted-foreground flex items-center gap-2 py-2 text-sm">
      <Loader2 class="size-4 animate-spin" />
      {{ t('connectors.github.loading') }}
    </div>

    <!-- No App registered: the picker simply is not part of this deployment. -->
    <template v-else-if="!state?.configured">
      <slot name="fallback" />
    </template>

    <!-- Registered, but this person has not linked a GitHub identity yet. -->
    <div v-else-if="!state.connected" class="space-y-2">
      <Button type="button" variant="outline" class="w-full" @click="openAndWatch(state.authorizeUrl)">
        <Github class="size-4" />
        {{ t('connectors.github.connect') }}
      </Button>
      <p class="text-muted-foreground text-xs">{{ t('connectors.github.connectHint') }}</p>
    </div>

    <!-- Connected, but the App is not installed anywhere this workspace can see. -->
    <div v-else-if="installations.length === 0" class="space-y-2">
      <Button type="button" variant="outline" class="w-full" @click="openAndWatch(state.installUrl)">
        <Plus class="size-4" />
        {{ t('connectors.github.install') }}
      </Button>
      <p class="text-muted-foreground text-xs">{{ t('connectors.github.installHint') }}</p>
    </div>

    <template v-else>
      <!-- Account switcher. A row of buttons rather than a select: the count is
           small, and seeing every org at once is the point of the control. -->
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          v-for="account in installations"
          :key="account.installationId"
          type="button"
          class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
          :class="
            account.installationId === selected
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:bg-muted'
          "
          @click="selected = account.installationId"
        >
          <img
            v-if="account.accountAvatarUrl"
            :src="account.accountAvatarUrl"
            alt=""
            class="size-4 rounded-full"
            loading="lazy"
          />
          {{ account.accountLogin }}
          <Lock v-if="account.repositorySelection === 'selected'" class="size-3 opacity-60" />
        </button>

        <button
          type="button"
          class="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs"
          @click="openAndWatch(state.installUrl)"
        >
          <Plus class="size-3" />
          {{ t('connectors.github.addAccount') }}
        </button>
      </div>

      <!-- `key` is load-bearing, not hygiene. Autocomplete refetches only when
           its query or open state changes, so the account this closure reads
           can change underneath it and the list would keep showing the previous
           account's repositories. Remounting on the account is what makes
           switching accounts actually reload. -->
      <Autocomplete
        :key="selected"
        :model-value="picked"
        :label="t('connectors.github.repository')"
        :placeholder="t('connectors.github.searchPlaceholder')"
        :load="loadRepos"
        :multiple="false"
        :empty-hint="t('connectors.github.noRepos')"
        @update:model-value="choose"
      />

      <!-- A repository lives in exactly one of these accounts, and the list is
           scoped to the selected one — so "no match" is ambiguous between "no
           such repository" and "you are looking in the wrong account". -->
      <p v-if="installations.length > 1" class="text-muted-foreground text-xs">
        {{ t('connectors.github.otherAccountHint') }}
      </p>

      <!-- Says why a list can be short, which is otherwise indistinguishable
           from the picker being broken. -->
      <p
        v-if="installations.find((i) => i.installationId === selected)?.repositorySelection === 'selected'"
        class="text-muted-foreground flex items-center gap-1.5 text-xs"
      >
        <Lock class="size-3 shrink-0" />
        {{ t('connectors.github.limitedHint') }}
        <button type="button" class="hover:text-foreground underline" @click="openAndWatch(state.installUrl)">
          {{ t('connectors.github.manageAccess') }}
        </button>
      </p>

      <button
        type="button"
        class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
        @click="accounts.refetch()"
      >
        <RefreshCw class="size-3" />
        {{ t('connectors.github.refresh') }}
      </button>
    </template>
  </div>
</template>
