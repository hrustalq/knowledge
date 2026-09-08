<script setup lang="ts">
// Provider configuration for this workspace. Every field is an OVERRIDE of the
// ASSISTANT_* env vars: clearing one hands the field back to the environment.
//
// That inheritance is the reason this form does not just POST its own state.
// The inputs are pre-filled with the *effective* value, so a naive save would
// silently convert every inherited field into a workspace override the first
// time anyone pressed Save. Fields the user did not touch are sent as null —
// "keep inheriting" — and only edited fields become overrides.
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { CircleCheck, CircleX, Loader2 } from 'lucide-vue-next'
import type { AiSettingsResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/api/client'
import AiSettingsSection from './AiSettingsSection.vue'
import AiProvidersSection from './AiProvidersSection.vue'

defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()
const queryClient = useQueryClient()
const query = useQuery(apiQueryOptions('/v1/ai/settings', { query: { workspaceId } }))
const settings = computed(() => query.data.value as AiSettingsResponse | undefined)

const PROVIDERS = [
  { value: 'none', label: 'None — assistant disabled' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
] as const

type Form = {
  provider: AiSettingsResponse['provider']
  baseUrl: string
  model: string
  temperature: number
  maxToolCalls: number
  timeoutMs: number
  agentModeEnabled: boolean
  pricePromptPerMTok: string
  priceCompletionPerMTok: string
  workspaceMonthlyTokenBudget: string
  defaultUserMonthlyTokenBudget: string
  enforceBudget: boolean
}

const form = ref<Form | null>(null)
/** The values the form loaded with — what "untouched" means when saving. */
const loaded = ref<Form | null>(null)
const apiKey = ref('')
const clearKey = ref(false)

function formFrom(s: AiSettingsResponse): Form {
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    temperature: s.temperature,
    maxToolCalls: s.maxToolCalls,
    timeoutMs: s.timeoutMs,
    agentModeEnabled: s.agentModeEnabled,
    pricePromptPerMTok: s.pricePromptPerMTok?.toString() ?? '',
    priceCompletionPerMTok: s.priceCompletionPerMTok?.toString() ?? '',
    workspaceMonthlyTokenBudget: s.workspaceMonthlyTokenBudget?.toString() ?? '',
    defaultUserMonthlyTokenBudget: s.defaultUserMonthlyTokenBudget?.toString() ?? '',
    enforceBudget: s.enforceBudget,
  }
}

watch(
  settings,
  (s) => {
    if (!s) return
    form.value = formFrom(s)
    loaded.value = formFrom(s)
    apiKey.value = ''
    clearKey.value = false
  },
  { immediate: true },
)

const dirty = computed(
  () =>
    (form.value !== null &&
      loaded.value !== null &&
      JSON.stringify(form.value) !== JSON.stringify(loaded.value)) ||
    apiKey.value !== '' ||
    clearKey.value,
)

/** "" → null (inherit / unlimited); a number → that number. */
function num(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * A field the user did not touch keeps its current layer: null when it was
 * inherited, its own value when it was already a workspace override.
 */
function override<K extends keyof Form>(key: K, source: keyof AiSettingsResponse['sources'] | null, value: unknown) {
  const untouched = form.value?.[key] === loaded.value?.[key]
  if (untouched && source && settings.value?.sources[source] === 'env') return null
  return value
}

const save = useApiMutation('patch', '/v1/ai/settings', { invalidates: () => [['/v1/ai/settings']] })

async function onSave() {
  const f = form.value
  if (!f) return
  await save.mutateAsync({
    body: {
      workspaceId,
      provider: override('provider', 'provider', f.provider) as AiSettingsResponse['provider'] | null,
      baseUrl: override('baseUrl', 'baseUrl', f.baseUrl.trim() || null) as string | null,
      model: override('model', 'model', f.model.trim() || null) as string | null,
      temperature: override('temperature', 'temperature', f.temperature) as number | null,
      maxToolCalls: override('maxToolCalls', 'maxToolCalls', f.maxToolCalls) as number | null,
      timeoutMs: override('timeoutMs', 'timeoutMs', f.timeoutMs) as number | null,
      agentModeEnabled: f.agentModeEnabled,
      pricePromptPerMTok: num(f.pricePromptPerMTok),
      priceCompletionPerMTok: num(f.priceCompletionPerMTok),
      workspaceMonthlyTokenBudget: num(f.workspaceMonthlyTokenBudget),
      defaultUserMonthlyTokenBudget: num(f.defaultUserMonthlyTokenBudget),
      enforceBudget: f.enforceBudget,
      // undefined keeps the stored key; null clears it. Only ever send one.
      ...(clearKey.value ? { apiKey: null } : apiKey.value ? { apiKey: apiKey.value } : {}),
    },
  })
  toast.success('AI settings saved')
}

const testing = ref(false)
const testResult = ref<{ ok: boolean; latencyMs: number; error?: string } | null>(null)

async function onTest() {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = (await api.post('/v1/ai/settings/test', { body: { workspaceId } })) as {
      ok: boolean
      latencyMs: number
      error?: string
    }
  } catch (e) {
    testResult.value = { ok: false, latencyMs: 0, error: (e as Error).message }
  } finally {
    testing.value = false
    void queryClient.invalidateQueries({ queryKey: ['/v1/ai/settings'] })
  }
}

/**
 * Inheritance is the resting state, so it is the overrides that get marked.
 * Badging all seven fields "from env" on a fresh workspace put a bordered pill
 * beside every label and said nothing, since that is simply what a workspace
 * that has never been configured looks like.
 */
function overridden(field: keyof AiSettingsResponse['sources']): boolean {
  return settings.value?.sources[field] === 'db'
}
</script>

<template>
  <div v-if="query.isPending.value" class="space-y-6">
    <div v-for="i in 3" :key="i" class="grid gap-x-10 gap-y-4 border-b py-6 md:grid-cols-[16rem_minmax(0,1fr)]">
      <Skeleton class="h-4 w-32" />
      <div class="max-w-xl space-y-4">
        <Skeleton class="h-9 w-full" />
        <Skeleton class="h-9 w-full" />
      </div>
    </div>
  </div>

  <form v-else-if="form" @submit.prevent="onSave">
    <AiProvidersSection
      v-if="settings"
      :can-manage="canManage"
      :routing="settings.routing"
      :can-store-secrets="settings.canStoreSecrets"
    />

    <AiSettingsSection
      title="Default provider"
      description="Used for anything not routed at a named profile above. Blank fields inherit the server's ASSISTANT_* environment values; anything you set here overrides them for this workspace only."
    >
      <label class="block space-y-1.5">
        <span class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          Provider
          <span v-if="overridden('provider')" class="text-primary/70">· overridden</span>
        </span>
        <Select v-model="form.provider" :disabled="!canManage">
          <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="p in PROVIDERS" :key="p.value" :value="p.value">{{ p.label }}</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            Base URL
            <span v-if="overridden('baseUrl')" class="text-primary/70">· overridden</span>
          </span>
          <Input v-model="form.baseUrl" :disabled="!canManage" placeholder="provider default" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            Model
            <span v-if="overridden('model')" class="text-primary/70">· overridden</span>
          </span>
          <Input v-model="form.model" :disabled="!canManage" placeholder="provider default" />
        </label>
      </div>

      <div class="space-y-1.5">
        <span class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          API key
          <span v-if="overridden('apiKey')" class="text-primary/70">· overridden</span>
        </span>
        <div class="flex items-center gap-2">
          <Input
            v-model="apiKey"
            type="password"
            autocomplete="off"
            :disabled="!canManage || clearKey || !settings?.canStoreSecrets"
            :placeholder="
              clearKey
                ? 'cleared on save — the environment key applies again'
                : (settings?.apiKeyHint ?? (settings?.hasApiKey ? 'set in the environment' : 'not configured'))
            "
          />
          <Button
            v-if="settings?.apiKeyHint"
            type="button"
            variant="outline"
            size="sm"
            class="shrink-0"
            :disabled="!canManage"
            @click="
              clearKey = !clearKey;
              apiKey = ''
            "
          >
            {{ clearKey ? 'Keep' : 'Clear' }}
          </Button>
        </div>
        <p class="text-muted-foreground text-xs">
          <template v-if="!settings?.canStoreSecrets">
            Keys can't be stored until SETTINGS_ENCRYPTION_KEY is set on the server. Until then, set ASSISTANT_API_KEY
            in the environment.
          </template>
          <template v-else-if="settings?.apiKeyHint">Stored for this workspace. Leave empty to keep it.</template>
          <template v-else>Saving a key here overrides the environment for this workspace.</template>
        </p>
      </div>
    </AiSettingsSection>

    <AiSettingsSection
      title="Behavior"
      description="How much freedom a single turn gets. The tool budget caps how many searches, reads and plugin calls the assistant may make before it has to answer."
    >
      <div class="grid gap-4 sm:grid-cols-3">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Temperature</span>
          <Input v-model.number="form.temperature" type="number" min="0" max="2" step="0.1" :disabled="!canManage" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Tool budget</span>
          <Input v-model.number="form.maxToolCalls" type="number" min="0" max="16" :disabled="!canManage" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Timeout (ms)</span>
          <Input v-model.number="form.timeoutMs" type="number" min="1000" max="600000" :disabled="!canManage" />
        </label>
      </div>
      <label class="flex items-start gap-2.5">
        <Checkbox
          class="mt-0.5"
          :model-value="form.agentModeEnabled"
          :disabled="!canManage"
          @update:model-value="form.agentModeEnabled = $event === true"
        />
        <span class="text-sm leading-snug">
          Allow Agent mode
          <span class="text-muted-foreground mt-0.5 block text-xs">
            Lets the chat create pages and open merge requests. Turning it off downgrades every turn to Ask mode.
          </span>
        </span>
      </label>
    </AiSettingsSection>

    <AiSettingsSection
      title="Budgets"
      description="Monthly token allowances, counted from the first of the month. Leave a field empty for unlimited."
    >
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Workspace tokens per month</span>
          <Input v-model="form.workspaceMonthlyTokenBudget" :disabled="!canManage" placeholder="unlimited" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Default per user</span>
          <Input v-model="form.defaultUserMonthlyTokenBudget" :disabled="!canManage" placeholder="unlimited" />
        </label>
      </div>
      <label class="flex items-start gap-2.5">
        <Checkbox
          class="mt-0.5"
          :model-value="form.enforceBudget"
          :disabled="!canManage"
          @update:model-value="form.enforceBudget = $event === true"
        />
        <span class="text-sm leading-snug">
          Refuse requests once a budget is spent
          <span class="text-muted-foreground mt-0.5 block text-xs">
            Off records usage without ever blocking anyone.
          </span>
        </span>
      </label>
    </AiSettingsSection>

    <AiSettingsSection
      title="Cost estimate"
      description="USD per million tokens, used only to put a number next to the usage figures. Leave empty to use the built-in list price for known models."
    >
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Prompt</span>
          <Input v-model="form.pricePromptPerMTok" :disabled="!canManage" placeholder="0.27" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Completion</span>
          <Input v-model="form.priceCompletionPerMTok" :disabled="!canManage" placeholder="1.10" />
        </label>
      </div>
    </AiSettingsSection>

    <!-- Sticky so Save stays reachable from any section of a long form.
         The negative bottom margin cancels the settings column's own py-6:
         without it the bar floats flush against the viewport while scrolling
         and then gains 32px of dead space under it at the end of the scroll,
         which reads as the buttons shifting. -->
    <div
      class="bg-background/85 sticky bottom-0 -mx-4 -mb-6 mt-2 flex flex-wrap items-center gap-3 border-t px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8"
    >
      <Button type="submit" size="sm" :disabled="!canManage || !dirty || save.isPending.value">
        {{ save.isPending.value ? 'Saving…' : 'Save changes' }}
      </Button>
      <Button type="button" variant="outline" size="sm" :disabled="!canManage || testing" @click="onTest">
        <Loader2 v-if="testing" class="size-3.5 animate-spin" />
        Test connection
      </Button>

      <p
        v-if="testResult"
        class="flex items-center gap-1.5 text-xs"
        :class="testResult.ok ? 'text-emerald-600' : 'text-destructive'"
      >
        <CircleCheck v-if="testResult.ok" class="size-3.5 shrink-0" />
        <CircleX v-else class="size-3.5 shrink-0" />
        {{ testResult.ok ? `Reached ${settings?.model} in ${testResult.latencyMs} ms` : testResult.error }}
      </p>
      <p v-else-if="dirty" class="text-muted-foreground text-xs">Unsaved changes</p>
      <p v-else-if="settings?.updatedAt" class="text-muted-foreground text-xs">
        Saved {{ new Date(settings.updatedAt).toLocaleString() }}
      </p>
    </div>
  </form>
</template>
