<script setup lang="ts">
/**
 * A project's methodology (#1125, docs/features/76): the blueprint it links,
 * live. Its templates, workflows, styleguide and glossary are read through
 * the link, never copied, so unlinking returns the project to exactly what it
 * had.
 *
 * Outside the settings page's one Save: a switch is structural and has its own
 * confirm step — the preview of the sections it would add and the levels its
 * pages would get. Nothing is ever deleted, moved or edited; only the ticked
 * sections are written.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Loader2 } from 'lucide-vue-next'
import {
  blueprintText,
  isMethodology,
  type BlueprintEntry,
  type ListBlueprintsResponse,
  type Locale,
  type MethodologyPreviewResponse,
  type ProjectLevelsResponse,
  type ProjectMethodologyResponse,
} from '@knowledge/contracts'
import { api, apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { Checkbox } from '@knowledge/ui/checkbox'
import { confirm } from '@knowledge/ui/confirm'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@knowledge/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@knowledge/ui/radio-group'
import { Skeleton } from '@knowledge/ui/skeleton'

const props = defineProps<{ projectId: string; canWrite: boolean }>()

const { t, locale: uiLocale } = useI18n()
const locale = computed(() => uiLocale.value as Locale)
const workspaceId = getWorkspaceId()
const path = computed(() => ({ path: { id: props.projectId } }))

const current = useQuery(computed(() => apiQueryOptions('/v1/projects/{id}/methodology', path.value)))
const methodology = computed(() => (current.data.value as ProjectMethodologyResponse | undefined)?.methodology ?? null)
const levelNames = computed(() => methodology.value?.levels.map((l) => blueprintText(l.name, locale.value)) ?? [])

// ---------------------------------------------------------------- the dialog
const open = ref(false)
const blueprintsQuery = useQuery(
  computed(() => ({ ...apiQueryOptions('/v1/blueprints', { query: { workspaceId } }), enabled: open.value })),
)
/** Methodologies first, then the rest in the list's order; blank offers nothing to link. */
const choices = computed(() => {
  const all = ((blueprintsQuery.data.value as ListBlueprintsResponse | undefined)?.blueprints ?? []).filter(
    (b) => b.enabled && b.key !== 'blank',
  )
  return [...all.filter((b) => isMethodology(b.blueprint)), ...all.filter((b) => !isMethodology(b.blueprint))]
})
// Today's levels (#1266), so a switch can say how many pages sit at a level before and after.
const todayQuery = useQuery(
  computed(() => ({ ...apiQueryOptions('/v1/projects/{id}/levels', path.value), enabled: open.value && !!methodology.value })),
)
const pagesAt = (levels: { pages: number }[] | undefined) => (levels ?? []).reduce((n, l) => n + l.pages, 0)
const levelledToday = computed(() => pagesAt((todayQuery.data.value as ProjectLevelsResponse | undefined)?.levels))
const levelledAfter = computed(() => pagesAt(preview.value?.levels))
const pickedName = computed(() => blueprintText(choices.value.find((c) => c.key === picked.value)?.blueprint.name, locale.value))

const picked = ref<string>('')
const preview = ref<MethodologyPreviewResponse | null>(null)
const previewError = ref<string | null>(null)
const loadingPreview = ref(false)
const ticked = ref<string[]>([])
const saving = ref(false)

function openChange() {
  picked.value = ''
  preview.value = null
  previewError.value = null
  open.value = true
}

watch(picked, async (key) => {
  preview.value = null
  previewError.value = null
  if (!key) return
  loadingPreview.value = true
  try {
    const res = await api.get('/v1/projects/{id}/methodology/preview', { ...path.value, query: { blueprint: key, locale: locale.value } })
    if (picked.value !== key) return
    preview.value = res
    // A first link usually wants the structure; a switch usually means the project already has its own tree.
    ticked.value = methodology.value ? [] : res.sections.map((s) => s.id)
  } catch (e) {
    if (picked.value === key) previewError.value = errorMessage(e, t)
  } finally {
    if (picked.value === key) loadingPreview.value = false
  }
})

function toggle(id: string, on: boolean) {
  ticked.value = on ? [...ticked.value, id] : ticked.value.filter((x) => x !== id)
}

async function link() {
  if (!picked.value || !preview.value || saving.value) return
  saving.value = true
  try {
    await api.put('/v1/projects/{id}/methodology', {
      ...path.value,
      body: { blueprintKey: picked.value, sections: ticked.value, locale: locale.value },
    })
    await current.refetch()
    open.value = false
    toast.success(t('projectSettings.methodology.linked', { name: blueprintText(methodology.value?.name, locale.value) }))
  } catch (e) {
    previewError.value = errorMessage(e, t)
  } finally {
    saving.value = false
  }
}

async function unlink() {
  const name = blueprintText(methodology.value?.name, locale.value)
  const ok = await confirm({
    title: t('projectSettings.methodology.unlinkTitle', { name }),
    description: t('projectSettings.methodology.unlinkBody', { name }),
    action: t('projectSettings.methodology.unlink'),
  })
  if (!ok) return
  try {
    await api.put('/v1/projects/{id}/methodology', { ...path.value, body: { blueprintKey: null } })
    await current.refetch()
    toast.success(t('projectSettings.methodology.unlinked', { name }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

const nameOf = (b: BlueprintEntry) => blueprintText(b.blueprint.name, locale.value)
</script>

<template>
  <section class="space-y-2" aria-labelledby="ps-methodology">
    <div>
      <h2 id="ps-methodology" class="text-sm font-semibold">{{ t('projectSettings.methodology.title') }}</h2>
      <p class="kn-measure mt-0.5 text-xs text-muted-foreground">{{ t('projectSettings.methodology.intro') }}</p>
    </div>

    <Skeleton v-if="current.isPending.value" class="h-14 w-full" />
    <p v-else-if="current.isError.value" class="text-sm text-destructive">{{ errorMessage(current.error.value, t) }}</p>
    <div v-else class="flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3">
      <div v-if="methodology" class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <span v-if="methodology.icon" aria-hidden="true">{{ methodology.icon }}</span>
          <span class="text-sm font-medium">{{ blueprintText(methodology.name, locale) }}</span>
          <Badge v-if="!methodology.enabled" variant="outline">{{ t('projectSettings.methodology.archived') }}</Badge>
        </div>
        <p v-if="levelNames.length" class="text-xs text-muted-foreground">
          <span class="sr-only">{{ t('projectSettings.methodology.levels') }}: </span>{{ levelNames.join(' · ') }}
        </p>
      </div>
      <p v-else class="kn-measure text-sm text-muted-foreground">{{ t('projectSettings.methodology.none') }}</p>

      <div v-if="canWrite" class="flex shrink-0 items-center gap-2">
        <Button type="button" variant="outline" size="sm" @click="openChange">
          {{ methodology ? t('projectSettings.methodology.change') : t('projectSettings.methodology.choose') }}
        </Button>
        <Button v-if="methodology" type="button" variant="ghost" size="sm" @click="unlink">
          {{ t('projectSettings.methodology.unlink') }}
        </Button>
      </div>
    </div>

    <Dialog v-model:open="open">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ methodology ? t('projectSettings.methodology.changeTitle') : t('projectSettings.methodology.chooseTitle') }}</DialogTitle>
          <DialogDescription>{{ t('projectSettings.methodology.safe') }}</DialogDescription>
        </DialogHeader>

        <div v-if="blueprintsQuery.isPending.value" class="space-y-2">
          <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
        </div>
        <p v-else-if="blueprintsQuery.isError.value" class="text-sm text-destructive" role="alert">
          {{ errorMessage(blueprintsQuery.error.value, t) }}
        </p>
        <RadioGroup v-else v-model="picked" class="gap-0 divide-y rounded-md border" :aria-label="t('projectSettings.methodology.title')">
          <label
            v-for="b in choices"
            :key="b.key"
            class="flex cursor-pointer items-start gap-3 px-3 py-2.5 has-[[data-disabled]]:cursor-default has-[[data-disabled]]:opacity-60"
          >
            <RadioGroupItem :value="b.key" class="mt-0.5" :disabled="b.key === methodology?.key" />
            <span class="min-w-0 space-y-0.5">
              <span class="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span v-if="b.blueprint.icon" aria-hidden="true">{{ b.blueprint.icon }}</span>
                {{ nameOf(b) }}
                <Badge v-if="b.blueprint.levels?.length" variant="secondary">
                  {{ t('projectSettings.methodology.levelCount', { n: b.blueprint.levels.length }, b.blueprint.levels.length) }}
                </Badge>
                <Badge v-if="b.key === methodology?.key" variant="outline">{{ t('projectSettings.methodology.current') }}</Badge>
              </span>
              <span v-if="blueprintText(b.blueprint.description, locale)" class="block text-xs text-muted-foreground">
                {{ blueprintText(b.blueprint.description, locale) }}
              </span>
            </span>
          </label>
        </RadioGroup>

        <div v-if="loadingPreview" class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 class="size-4 animate-spin" aria-hidden="true" /> {{ t('projectSettings.methodology.previewing') }}
        </div>
        <div v-else-if="preview" class="space-y-4">
          <p v-if="methodology" class="kn-measure text-sm">
            {{ t('projectSettings.methodology.switchEffect', { from: blueprintText(methodology.name, locale), to: pickedName }) }}
            <span class="text-muted-foreground tabular-nums">
              {{ t('projectSettings.methodology.levelShift', { before: levelledToday, after: levelledAfter }) }}
            </span>
          </p>
          <div class="space-y-2">
            <h3 class="text-sm font-semibold">{{ t('projectSettings.methodology.sections') }}</h3>
            <p v-if="preview.sections.length" class="text-xs text-muted-foreground">{{ t('projectSettings.methodology.sectionsHint') }}</p>
            <p v-if="!preview.sections.length" class="text-sm text-muted-foreground">{{ t('projectSettings.methodology.noSections') }}</p>
            <ul v-else class="space-y-1.5">
              <li v-for="s in preview.sections" :key="s.id">
                <label class="flex cursor-pointer items-start gap-2 text-sm">
                  <Checkbox class="mt-0.5" :model-value="ticked.includes(s.id)" @update:model-value="(v) => toggle(s.id, v === true)" />
                  <span class="min-w-0">
                    {{ s.title }}
                    <span class="text-xs text-muted-foreground">
                      <template v-if="s.parentTitle">· {{ t('projectSettings.methodology.under', { parent: s.parentTitle }) }}</template>
                      · {{ t('projectSettings.methodology.pages', { n: s.pages }, s.pages) }}
                    </span>
                  </span>
                </label>
              </li>
            </ul>
          </div>
          <div v-if="preview.levels.length" class="space-y-2">
            <h3 class="text-sm font-semibold">{{ t('projectSettings.methodology.levels') }}</h3>
            <ol class="divide-y rounded-md border text-sm">
              <li v-for="l in preview.levels" :key="l.key" class="flex items-center justify-between gap-3 px-3 py-1.5">
                <span>{{ l.name }}</span>
                <span class="text-xs tabular-nums text-muted-foreground">{{ t('projectSettings.methodology.pages', { n: l.pages }, l.pages) }}</span>
              </li>
            </ol>
          </div>
        </div>
        <p v-if="previewError" class="text-sm text-destructive" role="alert">{{ previewError }}</p>

        <DialogFooter class="bg-card sticky -bottom-6 -mx-6 -mb-6 rounded-b-xl border-t px-6 py-4">
          <Button type="button" variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
          <Button type="button" :disabled="!preview || saving" @click="link">
            <Loader2 v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
            {{
              methodology
                ? t('projectSettings.methodology.switchAdding', { n: ticked.length }, ticked.length)
                : t('projectSettings.methodology.linkAdding', { n: ticked.length }, ticked.length)
            }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
