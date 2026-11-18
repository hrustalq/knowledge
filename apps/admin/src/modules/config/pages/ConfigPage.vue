<script setup lang="ts">
/**
 * The configuration view (#1237): every env key this API process resolved,
 * grouped, with where its value came from. Read-only — env is owned by the
 * deploy (the k3s manifests and the GitHub production environment). Secrets
 * arrive as set/unset only; the API never sends their value.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Lock, SearchX } from 'lucide-vue-next'
import { ENV_GROUPS, type AdminConfigEntry } from '@knowledge/contracts'
import { PageLayout, PageState } from '@knowledge/ui/layout'
import { Input } from '@knowledge/ui/input'
import { Checkbox } from '@knowledge/ui/checkbox'
import { Label } from '@knowledge/ui/label'
import { apiQueryOptions } from '@/shared/api/queries'

const { t } = useI18n()
const config = useQuery(apiQueryOptions('/v1/admin/config'))

const search = ref('')
const fromEnvOnly = ref(false)

const valueText = (entry: AdminConfigEntry) => String(entry.value)

const groups = computed(() => {
  const needle = search.value.trim().toLowerCase()
  const entries = (config.data.value?.entries ?? []).filter(
    (e) =>
      (!fromEnvOnly.value || e.source === 'env') &&
      (!needle || e.key.toLowerCase().includes(needle) || (!e.secret && e.value !== null && valueText(e).toLowerCase().includes(needle))),
  )
  return ENV_GROUPS.map((group) => ({ group, entries: entries.filter((e) => e.group === group) })).filter((g) => g.entries.length)
})

const fromEnvCount = computed(() => config.data.value?.entries.filter((e) => e.source === 'env').length ?? 0)
</script>

<template>
  <PageLayout :title="t('admin.nav.config')" :subtitle="t('admin.sections.config')">
    <template #meta>
      <p v-if="config.data.value" class="text-muted-foreground text-caption max-w-prose">
        {{ t('admin.config.processNote', { version: config.data.value.version }) }}
      </p>
    </template>

    <PageState v-if="config.isPending.value" state="loading" :rows="8" row-class="h-9" />
    <PageState v-else-if="config.isError.value" state="error" :error="config.error.value" />
    <template v-else>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Input
          v-model="search"
          type="search"
          class="w-full sm:max-w-xs"
          :placeholder="t('admin.config.search')"
          :aria-label="t('admin.config.search')"
        />
        <div class="flex items-center gap-2">
          <Checkbox id="from-env" v-model="fromEnvOnly" />
          <Label for="from-env" class="text-sm font-normal">
            {{ t('admin.config.fromEnvOnly', { n: fromEnvCount }) }}
          </Label>
        </div>
      </div>

      <PageState
        v-if="!groups.length"
        state="empty"
        :icon="SearchX"
        :title="t('admin.config.noMatch')"
        :description="t('admin.config.noMatchHint')"
      />

      <section v-for="{ group, entries } in groups" :key="group" class="space-y-2" :aria-labelledby="`group-${group}`">
        <h2 :id="`group-${group}`" class="font-display flex items-baseline gap-2 text-base font-semibold tracking-tight">
          {{ t(`admin.config.groups.${group}`) }}
          <span class="text-muted-foreground text-caption font-sans font-normal">{{ entries.length }}</span>
        </h2>
        <div class="divide-y rounded-lg border">
          <div
            v-for="entry in entries"
            :key="entry.key"
            class="grid gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_auto] sm:items-baseline"
          >
            <code class="text-ui font-mono font-medium break-all">{{ entry.key }}</code>
            <span v-if="entry.secret" class="text-muted-foreground text-ui inline-flex items-center gap-1.5">
              <Lock class="size-3.5 shrink-0" aria-hidden="true" />
              {{ entry.set ? t('admin.config.secretSet') : t('admin.config.secretUnset') }}
            </span>
            <span v-else-if="entry.value === null || entry.value === ''" class="text-muted-foreground text-ui italic">
              {{ t('admin.config.unset') }}
            </span>
            <code v-else class="text-ui font-mono break-all whitespace-pre-wrap">{{ valueText(entry) }}</code>
            <span
              class="text-caption justify-self-start sm:justify-self-end"
              :class="entry.source === 'env' ? 'text-foreground font-medium' : 'text-muted-foreground'"
            >
              {{ t(`admin.config.source.${entry.source}`) }}
            </span>
          </div>
        </div>
      </section>
    </template>
  </PageLayout>
</template>
