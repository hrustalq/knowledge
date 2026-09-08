<script setup lang="ts">
// Named provider profiles, and which purpose each one serves.
//
// A workspace with no profiles keeps the single default config below and this
// section is just an invitation to add one — the whole feature is additive, so
// the simple case must stay simple.
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { CircleCheck, CircleDashed, CircleX, Plus, RefreshCw, Trash2 } from 'lucide-vue-next'
import type {
  AiConnectionTestResponse,
  AiProviderSummary,
  AiRouting,
  ListAiProvidersResponse,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import AiSettingsSection from './AiSettingsSection.vue'

const props = defineProps<{ canManage: boolean; routing: AiRouting; canStoreSecrets: boolean }>()

const workspaceId = getWorkspaceId()
const queryClient = useQueryClient()
const query = useQuery(apiQueryOptions('/v1/ai/providers', { query: { workspaceId } }))
const providers = computed(() => (query.data.value as ListAiProvidersResponse | undefined)?.providers ?? [])

const invalidates = () => [['/v1/ai/providers'], ['/v1/ai/settings'], ['/v1/ai/providers/choices']]
const createProvider = useApiMutation('post', '/v1/ai/providers', { invalidates })
const updateProvider = useApiMutation('patch', '/v1/ai/providers/{id}', { invalidates })
const deleteProvider = useApiMutation('delete', '/v1/ai/providers/{id}', { invalidates })
const saveSettings = useApiMutation('patch', '/v1/ai/settings', { invalidates })

// The three jobs a workspace might want on three different models.
const PURPOSES = [
  { key: 'chat', field: 'chatProviderId', label: 'Chat & agent', hint: 'Every turn in the assistant pane' },
  { key: 'review', field: 'reviewProviderId', label: 'Review & suggest', hint: 'Draft review and writing suggestions' },
  {
    key: 'extraction',
    field: 'extractionProviderId',
    label: 'Relation extraction',
    hint: 'Inferred graph edges, in the indexing worker',
  },
] as const

const open = ref(false)
const editing = ref<AiProviderSummary | null>(null)
const testingId = ref<string | null>(null)
const form = ref({
  name: '',
  provider: 'deepseek' as 'deepseek' | 'openai-compatible',
  baseUrl: '',
  model: '',
  apiKey: '',
  enabled: true,
})

function openNew() {
  editing.value = null
  form.value = { name: '', provider: 'deepseek', baseUrl: '', model: '', apiKey: '', enabled: true }
  open.value = true
}

function openEdit(p: AiProviderSummary) {
  editing.value = p
  // apiKey stays empty: write-only, same convention as everywhere else here.
  form.value = {
    name: p.name,
    provider: p.provider,
    baseUrl: p.baseUrl ?? '',
    model: p.model,
    apiKey: '',
    enabled: p.enabled,
  }
  open.value = true
}

async function submit() {
  const f = form.value
  const body = {
    name: f.name.trim(),
    provider: f.provider,
    baseUrl: f.baseUrl.trim() || null,
    model: f.model.trim(),
    enabled: f.enabled,
    ...(f.apiKey ? { apiKey: f.apiKey } : {}),
  }
  try {
    if (editing.value) {
      await updateProvider.mutateAsync({ path: { id: editing.value.id }, body })
      toast.success('Provider updated')
    } else {
      await createProvider.mutateAsync({ body: { workspaceId, ...body } })
      toast.success('Provider added')
    }
    open.value = false
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function test(p: AiProviderSummary) {
  testingId.value = p.id
  try {
    const result = (await api.post('/v1/ai/settings/test', {
      body: { workspaceId, providerId: p.id },
    })) as AiConnectionTestResponse
    if (result.ok) toast.success(`${p.name}: reached ${result.model} in ${result.latencyMs} ms`)
    else toast.error(`${p.name}: ${result.error}`)
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    testingId.value = null
    void queryClient.invalidateQueries({ queryKey: ['/v1/ai/providers'] })
  }
}

async function remove(p: AiProviderSummary) {
  try {
    await deleteProvider.mutateAsync({ path: { id: p.id } })
    toast.success(`Removed "${p.name}"`)
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/**
 * reka-ui reserves the empty string for "nothing selected", so an option
 * meaning "no route" needs a sentinel of its own — with `value=""` the trigger
 * silently showed Default even when a profile was routed.
 */
const UNROUTED = '__default__'

async function route(field: string, value: string) {
  try {
    await saveSettings.mutateAsync({ body: { workspaceId, [field]: value === UNROUTED ? null : value } })
  } catch (e) {
    toast.error((e as Error).message)
  }
}

function purposesServedBy(id: string): string[] {
  return PURPOSES.filter((p) => props.routing[p.key] === id).map((p) => p.label)
}
</script>

<template>
  <AiSettingsSection
    title="Providers"
    :description="
      providers.length
        ? 'Named configurations you can point each kind of work at. Anything left unrouted uses the default below.'
        : 'Add a profile to run different work on different models — a cheap one for background review, a strong one for chat. Until then everything uses the default below.'
    "
  >
    <ul v-if="providers.length" class="divide-y rounded-lg border">
      <li v-for="p in providers" :key="p.id" class="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <CircleCheck v-if="p.status === 'ok'" class="size-4 shrink-0 text-emerald-600" />
        <CircleX v-else-if="p.status === 'error'" class="text-destructive size-4 shrink-0" />
        <CircleDashed v-else class="text-muted-foreground size-4 shrink-0" />

        <button class="min-w-0 flex-1 text-left" :disabled="!canManage" @click="openEdit(p)">
          <span class="text-sm font-medium" :class="canManage && 'hover:text-primary'">{{ p.name }}</span>
          <span class="text-muted-foreground block truncate font-mono text-xs">{{ p.model }}</span>
        </button>

        <div class="flex flex-wrap items-center gap-1.5">
          <Badge v-for="label in purposesServedBy(p.id)" :key="label" variant="secondary" class="font-normal">
            {{ label }}
          </Badge>
          <Badge v-if="!p.enabled" variant="outline" class="text-muted-foreground font-normal">disabled</Badge>
        </div>

        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" :disabled="!canManage || testingId === p.id" @click="test(p)">
            <RefreshCw class="size-3.5" :class="testingId === p.id && 'animate-spin'" />
            Test
          </Button>
          <Button v-if="canManage" variant="ghost" size="sm" :aria-label="`Remove ${p.name}`" @click="remove(p)">
            <Trash2 class="size-3.5" />
          </Button>
        </div>
      </li>
    </ul>

    <p v-if="providers.some((p) => p.status === 'error')" class="text-destructive text-xs">
      {{ providers.find((p) => p.status === 'error')?.lastError }}
    </p>

    <Button v-if="canManage" type="button" variant="outline" size="sm" @click="openNew">
      <Plus class="size-3.5" /> Add provider
    </Button>

    <!-- Routing only means anything once there is something to route to. -->
    <div v-if="providers.length" class="space-y-3 border-t pt-4">
      <p class="text-xs font-medium">Routing</p>
      <label v-for="p in PURPOSES" :key="p.key" class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-sm">
          {{ p.label }}
          <span class="text-muted-foreground block text-xs">{{ p.hint }}</span>
        </span>
        <Select
          :model-value="routing[p.key] ?? UNROUTED"
          :disabled="!canManage"
          @update:model-value="route(p.field, String($event ?? UNROUTED))"
        >
          <SelectTrigger class="w-56"><SelectValue placeholder="Default" /></SelectTrigger>
          <SelectContent>
            <SelectItem :value="UNROUTED">Default (below)</SelectItem>
            <SelectItem v-for="opt in providers.filter((x) => x.enabled)" :key="opt.id" :value="opt.id">
              {{ opt.name }}
            </SelectItem>
          </SelectContent>
        </Select>
      </label>
    </div>

    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ editing ? 'Edit provider' : 'Add provider' }}</DialogTitle>
          <DialogDescription>
            A named endpoint and model. Give it a name you will recognise in the routing list and the usage
            breakdown.
          </DialogDescription>
        </DialogHeader>

        <form id="provider-form" class="space-y-4" @submit.prevent="submit">
          <label class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">Name</span>
            <Input v-model="form.name" required placeholder="DeepSeek prod" />
          </label>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block space-y-1.5">
              <span class="text-muted-foreground text-xs font-medium">Provider</span>
              <Select v-model="form.provider">
                <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="deepseek">DeepSeek</SelectItem>
                  <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label class="block space-y-1.5">
              <span class="text-muted-foreground text-xs font-medium">Model</span>
              <Input v-model="form.model" required placeholder="deepseek-chat" />
            </label>
          </div>
          <label class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">Base URL</span>
            <Input v-model="form.baseUrl" placeholder="provider default" />
          </label>
          <label class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">API key</span>
            <Input
              v-model="form.apiKey"
              type="password"
              autocomplete="off"
              :disabled="!canStoreSecrets"
              :placeholder="
                canStoreSecrets
                  ? (editing?.apiKeyHint ?? 'sk-…')
                  : 'SETTINGS_ENCRYPTION_KEY is not set on the server'
              "
            />
            <span v-if="editing?.hasApiKey" class="text-muted-foreground text-xs">Leave empty to keep it.</span>
          </label>
          <label class="flex items-center gap-2">
            <Checkbox :model-value="form.enabled" @update:model-value="form.enabled = $event === true" />
            <span class="text-sm">Enabled</span>
          </label>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" @click="open = false">Cancel</Button>
          <Button
            type="submit"
            form="provider-form"
            size="sm"
            :disabled="createProvider.isPending.value || updateProvider.isPending.value"
          >
            {{ editing ? 'Save' : 'Add' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </AiSettingsSection>
</template>
