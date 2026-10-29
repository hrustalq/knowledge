<script setup lang="ts">
/**
 * Agent memory (issue #73): whether coding agents may propose what they learned
 * in a session, how many proposals the workspace takes, and how close to an
 * existing page a proposal must be to amend it instead of starting a new one.
 *
 * Every row shows what is **asked for** beside what **applies**. The switch and
 * the two limits are capped by the deployment (CAPTURE_*): a workspace may ask
 * for less, never more, and when the ceiling wins the row says so — a silent
 * clamp lies about the configuration (CLAUDE.md). The thresholds are tuning,
 * not ceilings: an embedding model's cosine scale is its own, and moving them
 * widens nothing.
 *
 * The form shape is HealthSettings': an empty input inherits, and the
 * placeholder is what it inherits.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { AiSettingsResponse, CaptureSettings } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions, fetchApi } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getProjectId, getWorkspaceId } from '@/shared/api/api'
import { formatNumber } from '@/shared/utils/format'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { PageState } from '@/widgets/page'

const props = defineProps<{ canManage: boolean }>()

const { t } = useI18n()
const queryClient = useQueryClient()
const projects = useProjectsStore()
const workspaceId = getWorkspaceId()

const options = apiQueryOptions('/v1/ai/settings', { query: { workspaceId } })
const query = useQuery(options)
const capture = computed(() => (query.data.value as AiSettingsResponse | undefined)?.capture)

type LimitKey = 'perKeyPerHour' | 'perWorkspacePerDay'
type ThresholdKey = 'dedupeThreshold' | 'amendThreshold'
const LIMITS: readonly LimitKey[] = ['perKeyPerHour', 'perWorkspacePerDay']
const THRESHOLDS: readonly ThresholdKey[] = ['dedupeThreshold', 'amendThreshold']

/** The PATCH field each row writes. */
const FIELD = {
  enabled: 'captureEnabled',
  perKeyPerHour: 'capturePerKeyPerHour',
  perWorkspacePerDay: 'capturePerWorkspacePerDay',
  dedupeThreshold: 'captureDedupeThreshold',
  amendThreshold: 'captureAmendThreshold',
  parentDocumentId: 'captureParentDocumentId',
} as const

const ROOT = 'root'

const form = reactive({
  enabled: 'inherit' as 'inherit' | 'on' | 'off',
  perKeyPerHour: '',
  perWorkspacePerDay: '',
  dedupeThreshold: '',
  amendThreshold: '',
  parentDocumentId: ROOT,
})

function adopt(s: CaptureSettings) {
  form.enabled = s.enabled.requested === null ? 'inherit' : s.enabled.requested ? 'on' : 'off'
  for (const key of [...LIMITS, ...THRESHOLDS]) form[key] = s[key].requested === null ? '' : String(s[key].requested)
  form.parentDocumentId = s.parentDocumentId ?? ROOT
}
watch(capture, (s) => s && adopt(s), { immediate: true })

function parseInt0(raw: string): number | null {
  const v = raw.trim()
  if (v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}
function parseUnit(raw: string): number | null {
  const v = raw.trim()
  if (v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
}
function invalidLimit(key: LimitKey): boolean {
  return form[key].trim() !== '' && parseInt0(form[key]) === null
}
function invalidThreshold(key: ThresholdKey): boolean {
  return form[key].trim() !== '' && parseUnit(form[key]) === null
}
const anyInvalid = computed(() => LIMITS.some(invalidLimit) || THRESHOLDS.some(invalidThreshold))

const draft = computed(() => ({
  enabled: form.enabled === 'inherit' ? null : form.enabled === 'on',
  perKeyPerHour: parseInt0(form.perKeyPerHour),
  perWorkspacePerDay: parseInt0(form.perWorkspacePerDay),
  dedupeThreshold: parseUnit(form.dedupeThreshold),
  amendThreshold: parseUnit(form.amendThreshold),
  parentDocumentId: form.parentDocumentId === ROOT ? null : form.parentDocumentId,
}))

const changed = computed(() => {
  const s = capture.value
  if (!s) return {}
  const d = draft.value
  const out: Record<string, unknown> = {}
  if (d.enabled !== s.enabled.requested) out[FIELD.enabled] = d.enabled
  for (const key of [...LIMITS, ...THRESHOLDS]) if (d[key] !== s[key].requested) out[FIELD[key]] = d[key]
  if (d.parentDocumentId !== s.parentDocumentId) out[FIELD.parentDocumentId] = d.parentDocumentId
  return out
})
const dirty = computed(() => Object.keys(changed.value).length > 0)

const saving = ref(false)
async function save() {
  if (saving.value || anyInvalid.value || !dirty.value) return
  saving.value = true
  try {
    const next = await api.patch('/v1/ai/settings', { body: { workspaceId, ...changed.value } })
    queryClient.setQueryData(options.queryKey, next)
    toast.success(t('ai.capture.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

// --- labels -----------------------------------------------------------------
const onOff = (v: boolean) => (v ? t('ai.capture.on') : t('ai.capture.off'))
const thresholdLabel = (n: number) => n.toFixed(2)

// --- the parent page --------------------------------------------------------
// The setting is one page for the workspace, but a page lives in one project:
// captures in that project nest under it, and every other project's land at
// its root (CaptureService.parentFor). The picker lists the current project's
// pages, and names a parent from elsewhere so it is never shown as blank.
const pages = ref<ComboboxOption[]>([])
const foreignParent = ref<string | null>(null)

onMounted(async () => {
  const projectId = getProjectId()
  try {
    const res = await fetchApi(queryClient, '/v1/documents', {
      query: { workspaceId, ...(projectId ? { projectId } : {}), limit: '100' },
    })
    pages.value = res.items.map((d) => ({ value: d.documentId, label: d.title }))
  } catch {
    // The picker falls back to the project root and the current value's name.
  }
})

watch(
  () => capture.value?.parentDocumentId,
  async (id) => {
    foreignParent.value = null
    if (!id || pages.value.some((p) => p.value === id)) return
    try {
      const doc = (await fetchApi(queryClient, '/v1/documents/{id}', { path: { id } })) as {
        document: { title: string; projectId: string }
      }
      const project = projects.items.find((p) => p.projectId === doc.document.projectId)?.name
      foreignParent.value = project ? `${doc.document.title} · ${project}` : doc.document.title
    } catch {
      foreignParent.value = t('ai.capture.parentMissing')
    }
  },
  { immediate: true },
)

const parentOptions = computed<ComboboxOption[]>(() => {
  const list: ComboboxOption[] = [{ value: ROOT, label: t('ai.capture.parentRoot') }, ...pages.value]
  const id = capture.value?.parentDocumentId
  if (id && foreignParent.value && !pages.value.some((p) => p.value === id)) {
    list.push({ value: id, label: foreignParent.value })
  }
  return list
})
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" :rows="5" row-class="h-14" />
  <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />

  <form v-else-if="capture" class="space-y-5" @submit.prevent="save">
    <p class="kn-measure text-sm text-muted-foreground">
      {{ t('ai.capture.intro') }}
      <RouterLink to="/captures" class="text-primary hover:underline">{{ t('ai.capture.openInbox') }}</RouterLink>
    </p>

    <div class="divide-y rounded-md border">
      <!-- The switch. -->
      <div class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
        <div class="min-w-0">
          <span id="cap-enabled-label" class="text-sm font-medium">{{ t('ai.capture.enabled.label') }}</span>
          <p class="kn-measure text-xs text-muted-foreground">{{ t('ai.capture.enabled.hint') }}</p>
          <p class="mt-1 text-xs">
            <span class="text-muted-foreground">{{ t('ai.capture.applies') }}</span>
            {{ onOff(capture.enabled.effective) }}
            <span v-if="capture.enabled.source === 'clamped'" class="ml-1 text-destructive">
              {{ t('ai.capture.clampedOff') }}
            </span>
          </p>
        </div>
        <Select v-model="form.enabled" :disabled="!props.canManage">
          <SelectTrigger class="h-9 w-full" aria-labelledby="cap-enabled-label"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{{ t('ai.capture.inherit', { value: onOff(capture.enabled.ceiling) }) }}</SelectItem>
            <SelectItem value="on">{{ t('ai.capture.on') }}</SelectItem>
            <SelectItem value="off">{{ t('ai.capture.off') }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <!-- The two limits: capped by the deployment. -->
      <div v-for="key in LIMITS" :key="key" class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
        <div class="min-w-0">
          <label :for="`cap-${key}`" class="text-sm font-medium">{{ t(`ai.capture.${key}.label`) }}</label>
          <p class="kn-measure text-xs text-muted-foreground">{{ t(`ai.capture.${key}.hint`) }}</p>
          <p class="mt-1 text-xs">
            <span class="text-muted-foreground">{{ t('ai.capture.applies') }}</span>
            {{ formatNumber(capture[key].effective) }}
            <span v-if="capture[key].source === 'clamped'" class="ml-1 text-destructive">
              {{ t('ai.capture.clamped', { asked: formatNumber(capture[key].requested ?? 0) }) }}
            </span>
            <span v-else-if="capture[key].requested !== null" class="ml-1 text-primary/80">{{ t('ai.overridden') }}</span>
          </p>
        </div>
        <div class="space-y-1">
          <Input
            :id="`cap-${key}`"
            v-model="form[key]"
            type="number"
            inputmode="numeric"
            min="0"
            step="1"
            class="h-9"
            :placeholder="formatNumber(capture[key].ceiling)"
            :disabled="!props.canManage"
            :aria-invalid="invalidLimit(key) || undefined"
            :aria-describedby="`cap-${key}-ceiling`"
          />
          <p :id="`cap-${key}-ceiling`" class="text-xs text-muted-foreground">
            {{ t('ai.capture.ceiling', { value: formatNumber(capture[key].ceiling) }) }}
          </p>
        </div>
      </div>

      <!-- The thresholds: tuning, not ceilings. -->
      <div v-for="key in THRESHOLDS" :key="key" class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
        <div class="min-w-0">
          <label :for="`cap-${key}`" class="text-sm font-medium">{{ t(`ai.capture.${key}.label`) }}</label>
          <p class="kn-measure text-xs text-muted-foreground">{{ t(`ai.capture.${key}.hint`) }}</p>
          <p class="mt-1 text-xs">
            <span class="text-muted-foreground">{{ t('ai.capture.applies') }}</span>
            <span class="tabular-nums">{{ thresholdLabel(capture[key].effective) }}</span>
            <span
              v-if="key === 'amendThreshold' && capture[key].requested !== null && capture[key].effective < capture[key].requested!"
              class="ml-1 text-muted-foreground"
            >
              {{ t('ai.capture.amendHeld') }}
            </span>
            <span v-else-if="capture[key].requested !== null" class="ml-1 text-primary/80">{{ t('ai.overridden') }}</span>
          </p>
        </div>
        <Input
          :id="`cap-${key}`"
          v-model="form[key]"
          type="number"
          inputmode="decimal"
          min="0"
          max="1"
          step="0.01"
          class="h-9"
          :placeholder="thresholdLabel(capture[key].effective)"
          :disabled="!props.canManage"
          :aria-invalid="invalidThreshold(key) || undefined"
        />
      </div>

      <!-- Where new captured pages nest. -->
      <div class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
        <div class="min-w-0">
          <span class="text-sm font-medium">{{ t('ai.capture.parent.label') }}</span>
          <p class="kn-measure text-xs text-muted-foreground">{{ t('ai.capture.parent.hint') }}</p>
        </div>
        <Combobox
          v-model="form.parentDocumentId"
          :options="parentOptions"
          :label="t('ai.capture.parent.label')"
          :search-placeholder="t('ai.capture.parent.search')"
          :disabled="!props.canManage"
          align="end"
        />
      </div>
    </div>

    <div v-if="props.canManage" class="flex items-center gap-2">
      <Button type="submit" size="sm" :disabled="!dirty || anyInvalid || saving">
        {{ saving ? t('common.saving') : t('common.save') }}
      </Button>
      <Button type="button" variant="ghost" size="sm" :disabled="!dirty || saving" @click="adopt(capture)">
        {{ t('common.discard') }}
      </Button>
    </div>
  </form>
</template>
