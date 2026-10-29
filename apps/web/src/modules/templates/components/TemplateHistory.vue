<script setup lang="ts">
/**
 * A template's versions (issue #69), newest first, each comparable with the
 * one before it — or any other — as a line diff of the stored source.
 *
 * Versions are immutable rows, never revisions, so there is no compare
 * endpoint to ask: both sources are fetched and diffed here with the local
 * `lineDiff` the editor's review and the connector review use, rendered by the
 * same `DiffView` a revision comparison is.
 *
 * An untouched built-in has one version, the one shipped in code; a customised
 * one lists the shipped version under the workspace's own, because its own
 * continue that line.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CompareResponse,
  TemplateSummary,
  TemplateVersionInfo,
} from '@knowledge/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { fetchApi } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { formatDateTime } from '@/shared/utils/format'
import { lineDiff } from '@/core/line-diff'
import { useTemplatesStore } from '@/entities/template'
import { useMembers } from '@/entities/person'
import { Skeleton } from '@/shared/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { DiffView } from '@/entities/document'

const props = defineProps<{ template: TemplateSummary }>()

const { t } = useI18n()
const templates = useTemplatesStore()
const { nameOf } = useMembers()
const queryClient = useQueryClient()

const versions = ref<TemplateVersionInfo[] | null>(null)
const error = ref<string | null>(null)
/** The version being read, and the one it is compared with (older by default). */
const selected = ref<number | null>(null)
const against = ref<number | null>(null)
const compare = ref<CompareResponse | null>(null)
const comparing = ref(false)

watch(
  () => [props.template.ref, props.template.currentVersion] as const,
  async ([ref], prev) => {
    versions.value = null
    error.value = null
    compare.value = null
    try {
      const id = props.template.id
      // The same template at a new version: the list just grew, so ask again.
      versions.value = id
        ? (await fetchApi(queryClient, '/v1/templates/{id}/versions', { path: { id } }, { fresh: prev?.[0] === ref })).versions
        : [{ version: props.template.currentVersion, createdBy: null, createdAt: null, builtIn: true }]
      selectVersion(versions.value[0]?.version ?? null)
    } catch (e) {
      error.value = errorMessage(e, t)
    }
  },
  { immediate: true },
)

function selectVersion(version: number | null) {
  selected.value = version
  const list = versions.value ?? []
  const index = list.findIndex((v) => v.version === version)
  against.value = index >= 0 ? (list[index + 1]?.version ?? null) : null
}

/** Versions the selected one can be compared with: every other one. */
const others = computed(() => (versions.value ?? []).filter((v) => v.version !== selected.value))

let seq = 0
watch([selected, against], async ([to, from]) => {
  compare.value = null
  if (to === null || from === null) return
  const mine = ++seq
  comparing.value = true
  try {
    const [older, newer] = await Promise.all([
      templates.detail(props.template.ref, Math.min(from, to)),
      templates.detail(props.template.ref, Math.max(from, to)),
    ])
    if (mine !== seq) return
    const { hunks, additions, deletions } = lineDiff(older.source, newer.source)
    const side = (version: number) => ({
      revisionId: `${props.template.ref}@${version}`,
      revisionNumber: version,
      branch: null,
      contentHash: null,
    })
    compare.value = {
      documentId: '',
      from: side(older.version),
      to: side(newer.version),
      comparisonMode: 'direct',
      mergeBaseRevisionId: null,
      summary: { additions, deletions },
      hunks,
      structural: null,
      semantic: null,
    }
  } catch (e) {
    if (mine === seq) error.value = errorMessage(e, t)
  } finally {
    if (mine === seq) comparing.value = false
  }
})

function versionLine(v: TemplateVersionInfo): string {
  if (v.builtIn) return t('templates.history.shipped')
  const who = v.createdBy ? nameOf(v.createdBy) : t('templates.history.someone')
  return v.createdAt ? t('templates.history.by', { who, when: formatDateTime(v.createdAt) }) : who
}
</script>

<template>
  <p v-if="error" class="text-sm">{{ error }}</p>
  <div v-else-if="!versions" class="space-y-2">
    <Skeleton v-for="i in 3" :key="i" class="h-9 w-full" />
  </div>
  <div v-else class="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
    <ol class="space-y-1" :aria-label="t('templates.history.title')">
      <li v-for="v in versions" :key="v.version">
        <button
          type="button"
          class="kn-tpl-version"
          :data-selected="selected === v.version || undefined"
          :aria-current="selected === v.version || undefined"
          @click="selectVersion(v.version)"
        >
          <span class="font-medium">
            {{ t('templates.version', { version: v.version }) }}
            <span v-if="v.version === template.currentVersion" class="text-muted-foreground text-xs font-normal">
              · {{ t('templates.history.current') }}
            </span>
          </span>
          <span class="text-muted-foreground truncate text-xs">{{ versionLine(v) }}</span>
        </button>
      </li>
    </ol>

    <div class="min-w-0 space-y-3">
      <p v-if="versions.length < 2" class="text-muted-foreground text-sm">{{ t('templates.history.onlyOne') }}</p>
      <template v-else>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="text-muted-foreground">{{ t('templates.history.compare', { version: selected }) }}</span>
          <Select :model-value="against === null ? '' : String(against)" @update:model-value="against = Number($event)">
            <SelectTrigger
              class="h-8 w-28 text-xs"
              :aria-label="t('templates.history.compare', { version: selected })"
            ><SelectValue :placeholder="t('templates.history.pick')" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="v in others" :key="v.version" :value="String(v.version)">
                {{ t('templates.version', { version: v.version }) }}
              </SelectItem>
            </SelectContent>
          </Select>
          <span v-if="compare" class="text-muted-foreground text-xs">
            +{{ compare.summary.additions }} −{{ compare.summary.deletions }}
          </span>
        </div>
        <div v-if="comparing" class="space-y-2">
          <Skeleton class="h-4 w-1/2" />
          <Skeleton class="h-40 w-full" />
        </div>
        <DiffView v-else-if="compare" :compare="compare" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.kn-tpl-version {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.125rem;
  border-radius: calc(var(--radius) - 2px);
  padding: 0.375rem 0.625rem;
  text-align: left;
  font-size: var(--kn-text-sm);
  transition: background-color 120ms;
}
.kn-tpl-version:hover {
  background: var(--accent);
}
.kn-tpl-version[data-selected] {
  background: color-mix(in oklab, var(--primary) 10%, transparent);
}
</style>
