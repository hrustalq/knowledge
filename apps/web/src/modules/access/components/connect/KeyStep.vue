<script setup lang="ts">
/**
 * The wizard's key step (#1225). Scope and toolsets arrive as defaults from
 * the earlier answers; a pick made here is an override that later answers
 * leave alone. The plaintext exists only in the wizard's memory, handed up in
 * `created`, and is gone on reload by design.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from 'lucide-vue-next'
import { useQueryClient } from '@tanstack/vue-query'
import type { ApiKeyInfo, ApiKeyScope, McpToolset, ProjectSummary } from '@knowledge/contracts'
import { API_KEY_SCOPES, MCP_TOOLSET_KEYS } from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { Label } from '@knowledge/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
import { api, fetchApi } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { CopyBlock } from '@/entities/access'
import { useWorkspacesStore } from '@/stores/workspaces'
import ChoiceCards from './ChoiceCards.vue'

const props = defineProps<{
  defaultName: string
  suggestedScope: ApiKeyScope
  suggestedToolsets: McpToolset[]
  fresh: { key: ApiKeyInfo; apiKey: string } | null
}>()
const emit = defineEmits<{ created: [value: { key: ApiKeyInfo; apiKey: string }] }>()
const mode = defineModel<'new' | 'existing'>('mode', { required: true })

const { t } = useI18n()
const queryClient = useQueryClient()
const workspaces = useWorkspacesStore()

const EXPIRY_CHOICES = ['never', '30', '90', '365'] as const
const ALL = 'all'
const PICKABLE = MCP_TOOLSET_KEYS.filter((key) => key !== 'core')

const form = reactive({
  name: '',
  workspaceId: ALL,
  expiry: 'never' as (typeof EXPIRY_CHOICES)[number],
  projectIds: [] as string[],
})
const scopePick = ref<ApiKeyScope | null>(null)
const scope = computed({ get: () => scopePick.value ?? props.suggestedScope, set: (v) => (scopePick.value = v) })
const limit = ref(false)
const toolsetPick = ref<McpToolset[] | null>(null)
const toolsets = computed(() => toolsetPick.value ?? props.suggestedToolsets)

function toggleToolset(key: McpToolset) {
  const now = toolsets.value
  toolsetPick.value = now.includes(key) ? now.filter((k) => k !== key) : [...now, key]
}

/* A capture key's project pin — refused by the API on any other scope. */
const pinProjects = ref<ProjectSummary[]>([])
const pinWorkspace = computed(() => (form.workspaceId === ALL ? getWorkspaceId() : form.workspaceId))
watch(
  [scope, pinWorkspace],
  async ([s, ws]) => {
    form.projectIds = []
    if (s !== 'capture') return
    try {
      pinProjects.value = (await fetchApi(queryClient, '/v1/projects', { query: { workspaceId: ws } })).projects
    } catch {
      pinProjects.value = []
    }
  },
  { immediate: true },
)
function togglePin(id: string) {
  form.projectIds = form.projectIds.includes(id) ? form.projectIds.filter((p) => p !== id) : [...form.projectIds, id]
}

const scopeOptions = computed(() =>
  API_KEY_SCOPES.map((s) => ({ value: s, label: t(`connect.keys.scopes.${s}`), hint: t(`connect.keys.scopeHint.${s}`) })),
)

const creating = ref(false)
const error = ref<string | null>(null)

async function create() {
  creating.value = true
  error.value = null
  try {
    const res = await api.post('/v1/me/api-keys', {
      body: {
        name: form.name.trim() || props.defaultName,
        scope: scope.value,
        ...(form.workspaceId !== ALL ? { workspaceId: form.workspaceId } : {}),
        ...(form.expiry !== 'never' ? { expiresInDays: Number(form.expiry) } : {}),
        ...(scope.value === 'capture' && form.projectIds.length ? { projectIds: form.projectIds } : {}),
        ...(limit.value && toolsets.value.length ? { toolsets: toolsets.value } : {}),
      },
    })
    emit('created', { key: res.key, apiKey: res.apiKey })
  } catch (e) {
    error.value = errorMessage(e, t) || t('connect.keys.createFailed')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="grid min-w-0 gap-5">
    <!-- The one sighting of the value. -->
    <div v-if="fresh" class="grid gap-2 rounded-lg border border-dashed kn-callout-warning p-3.5" role="status">
      <p class="flex items-start gap-2 text-xs text-panel-warning-ink">
        <TriangleAlert class="size-3.5 shrink-0 translate-y-0.5" aria-hidden="true" />
        <span>{{ t('connect.wizard.key.created', { name: fresh.key.name }) }} {{ t('connect.wizard.key.reload') }}</span>
      </p>
      <CopyBlock :code="fresh.apiKey" :label="t('connect.wizard.key.label')" secret />
    </div>

    <template v-else>
      <ChoiceCards
        v-model="mode"
        name="kn-wiz-key-mode"
        compact
        :legend="t('connect.wizard.key.title')"
        :options="[
          { value: 'new', label: t('connect.wizard.key.new') },
          { value: 'existing', label: t('connect.wizard.key.have') },
        ]"
      />

      <p v-if="mode === 'existing'" class="kn-measure text-xs text-muted-foreground">{{ t('connect.wizard.key.haveHint') }}</p>

      <form v-else class="grid min-w-0 gap-5" @submit.prevent="create">
        <div class="grid gap-1.5">
          <Label for="kn-wiz-key-name" class="text-xs">{{ t('connect.keys.name') }}</Label>
          <Input id="kn-wiz-key-name" v-model="form.name" :placeholder="defaultName" maxlength="80" />
        </div>

        <ChoiceCards
          v-model="scope"
          name="kn-wiz-scope"
          :legend="t('connect.keys.scope')"
          :note="scopePick === null ? t('connect.wizard.key.suggested') : undefined"
          :options="scopeOptions"
        />

        <fieldset v-if="scope === 'capture' && pinProjects.length" class="grid gap-1.5">
          <legend class="mb-1 text-xs font-medium text-muted-foreground">{{ t('connect.keys.projects') }}</legend>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="p in pinProjects"
              :key="p.projectId"
              type="button"
              class="rounded-md border px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring"
              :class="form.projectIds.includes(p.projectId) ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
              :aria-pressed="form.projectIds.includes(p.projectId)"
              @click="togglePin(p.projectId)"
            >
              {{ p.name }}
            </button>
          </div>
          <p class="text-caption text-muted-foreground">
            {{ form.projectIds.length ? t('connect.keys.projectsPinned', { n: form.projectIds.length }, form.projectIds.length) : t('connect.keys.projectsAll') }}
          </p>
        </fieldset>

        <div class="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="kn-wiz-key-ws" class="text-xs">{{ t('connect.keys.workspace') }}</Label>
            <Select v-model="form.workspaceId">
              <SelectTrigger id="kn-wiz-key-ws" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="ALL">{{ t('connect.keys.allWorkspaces') }}</SelectItem>
                <SelectItem v-for="w in workspaces.items" :key="w.workspaceId" :value="w.workspaceId">{{ w.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="kn-wiz-key-exp" class="text-xs">{{ t('connect.keys.expiry') }}</Label>
            <Select v-model="form.expiry">
              <SelectTrigger id="kn-wiz-key-exp" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="e in EXPIRY_CHOICES" :key="e" :value="e">
                  {{ e === 'never' ? t('connect.keys.never') : t('connect.keys.days', { n: e }) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <fieldset class="grid gap-2">
          <legend class="sr-only">{{ t('connect.keys.toolsetPicker.legend') }}</legend>
          <label class="flex cursor-pointer items-start gap-2.5 text-sm">
            <input v-model="limit" type="checkbox" class="mt-0.5 size-4 shrink-0 accent-primary" />
            <span>
              {{ t('connect.wizard.key.limit') }}
              <span class="mt-0.5 block text-xs text-muted-foreground">{{ t('connect.wizard.key.limitHint') }}</span>
            </span>
          </label>
          <!-- Each toolset with what it does, in text: a tooltip never reaches the keyboard or a touch screen. -->
          <div v-if="limit" class="grid gap-x-4 gap-y-2 pl-6.5 sm:grid-cols-2">
            <p class="text-xs text-muted-foreground sm:col-span-2">
              <span class="font-medium text-foreground">{{ t('connect.toolsets.core.label') }}</span> · {{ t('connect.keys.toolsetPicker.always') }}
            </p>
            <label v-for="key in PICKABLE" :key="key" class="flex min-w-0 cursor-pointer items-start gap-2.5">
              <input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-primary" :checked="toolsets.includes(key)" @change="toggleToolset(key)" />
              <span class="min-w-0">
                <span class="block text-sm">{{ t(`connect.toolsets.${key}.label`) }}</span>
                <span class="block text-caption text-muted-foreground">{{ t(`connect.toolsets.${key}.description`) }}</span>
              </span>
            </label>
          </div>
          <p v-else class="pl-6.5 text-caption text-muted-foreground">{{ t('connect.wizard.key.unlimited') }}</p>
        </fieldset>

        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" :disabled="creating">
            {{ creating ? t('connect.keys.creating') : t('connect.keys.create') }}
          </Button>
          <p class="text-caption text-muted-foreground">{{ t('connect.wizard.key.reload') }}</p>
        </div>
        <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
      </form>
    </template>
  </div>
</template>
