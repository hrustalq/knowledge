<script setup lang="ts">
/**
 * The branch half of the repository picker (docs/features/30).
 *
 * Replaces the free-text Branch box once a repository has been picked through
 * the App. Worth the component rather than a text input because a mistyped
 * branch is one of the three failures #28 is about, and this makes it
 * unrepresentable: you cannot pick a branch that is not there.
 *
 * The empty value is kept as a real choice rather than being filled in. Empty
 * means "follow the repository's default", which is now honoured server-side by
 * `resolveBranch` — so a connector left on it keeps working after somebody
 * renames the default branch, where a pinned one silently stops.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { GitBranch } from 'lucide-vue-next'
import type { GithubBranchesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import Autocomplete, { type AutocompleteOption } from '@/components/ui/autocomplete/Autocomplete.vue'

const props = defineProps<{
  workspaceId: string
  installationId: string
  repoUrl: string
  modelValue: string
}>()

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const { t } = useI18n()

const slug = computed(() => {
  const match = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(props.repoUrl)
  return match ? { owner: match[1], repo: match[2] } : null
})

const branches = useQuery({
  ...apiQueryOptions('/v1/connectors/github/branches', {
    query: {
      workspaceId: props.workspaceId,
      installationId: props.installationId,
      owner: slug.value?.owner ?? '',
      repo: slug.value?.repo ?? '',
    },
  }),
  enabled: computed(() => Boolean(slug.value && props.installationId)),
})

const options = computed<AutocompleteOption[]>(() => {
  const res = branches.data.value as GithubBranchesResponse | undefined
  if (!res?.ok) return []
  return [
    // The empty option is first and explicitly labelled, so "follow the
    // default" reads as a decision rather than as an unanswered question.
    { value: '', label: t('connectors.github.defaultBranch'), meta: defaultName.value },
    ...res.branches.map((b) => ({
      value: b.name,
      label: b.name,
      meta: b.isDefault ? t('connectors.github.isDefault') : undefined,
    })),
  ]
})

const defaultName = computed(() => {
  const res = branches.data.value as GithubBranchesResponse | undefined
  return res?.ok ? (res.branches.find((b) => b.isDefault)?.name ?? '') : ''
})
</script>

<template>
  <div class="space-y-1.5">
    <Autocomplete
      :model-value="[modelValue]"
      :label="t('connectors.github.branch')"
      :placeholder="t('connectors.github.branchPlaceholder')"
      :options="options"
      :multiple="false"
      :disabled="!slug || !installationId"
      :empty-hint="t('connectors.github.noBranches')"
      @update:model-value="emit('update:modelValue', $event[0] ?? '')"
    />
    <p class="text-muted-foreground flex items-center gap-1.5 text-xs">
      <GitBranch class="size-3 shrink-0" />
      <template v-if="modelValue">{{ t('connectors.github.branchPinned', { branch: modelValue }) }}</template>
      <template v-else-if="defaultName">
        {{ t('connectors.github.branchFollows', { branch: defaultName }) }}
      </template>
      <template v-else>{{ t('connectors.github.branchHint') }}</template>
    </p>
  </div>
</template>
