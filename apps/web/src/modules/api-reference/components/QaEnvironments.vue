<script setup lang="ts">
/**
 * Test environments (#483, phase 5), the third tab of /qa: where a server run
 * sends and with what. Editors add and change them; everyone else reads the
 * names, servers and inputs.
 *
 * Secrets are write-only, as the API stores them: a set secret shows as its
 * name and "set", and can be replaced or removed, never read back. New secret
 * values are typed into password fields and leave this page in the save
 * request only.
 *
 * The server is the one a run uses for any step whose spec declares it in
 * `servers` — the proxy's own target rule — so the form says so instead of
 * promising it reaches any host.
 */
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { KeyRound, Pencil, Plus, Server, Trash2, Undo2 } from 'lucide-vue-next'
import type { ApiTestEnvironment, ListApiTestEnvironmentsResponse, SaveApiTestEnvironmentRequest } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import type { Row } from '@/modules/api-reference/model/test-fixture'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { confirm } from '@/shared/ui/confirm'
import { PageState } from '@/widgets/page'
import FixtureRows from '@/modules/api-reference/components/FixtureRows.vue'

const props = defineProps<{ workspaceId: string; runnerOn: boolean }>()
const { t } = useI18n()
const auth = useAuthStore()
const queryClient = useQueryClient()
const canEdit = computed(() => auth.canEdit)

const options = computed(() => apiQueryOptions('/v1/workspaces/{id}/test-environments', { path: { id: props.workspaceId } }))
const query = useQuery(options)
const environments = computed(() => (query.data.value as ListApiTestEnvironmentsResponse | undefined)?.environments ?? [])

/** The open form: an environment's id, `new`, or nothing. */
const editing = ref<string | 'new' | null>(null)
const draft = reactive({
  name: '',
  server: '',
  inputs: [] as Row[],
  /** Stored secret names, each kept, replaced (a value) or removed. */
  kept: [] as Array<{ name: string; replace: string; remove: boolean }>,
  added: [] as Row[],
})
const saving = ref(false)

function open(env: ApiTestEnvironment | null) {
  editing.value = env?.id ?? 'new'
  draft.name = env?.name ?? ''
  draft.server = env?.server ?? ''
  draft.inputs = Object.entries(env?.inputs ?? {}).map(([name, value]) => ({ name, value }))
  draft.kept = (env?.secrets ?? []).map((name) => ({ name, replace: '', remove: false }))
  draft.added = []
}

function body(): SaveApiTestEnvironmentRequest {
  const secrets: Record<string, string | null> = {}
  for (const k of draft.kept) {
    if (k.remove) secrets[k.name] = null
    else if (k.replace) secrets[k.name] = k.replace
  }
  for (const r of draft.added) if (r.name.trim()) secrets[r.name.trim()] = r.value
  return {
    name: draft.name.trim(),
    server: draft.server.trim() || null,
    inputs: Object.fromEntries(draft.inputs.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value])),
    secrets,
  }
}

async function save() {
  if (saving.value || !editing.value) return
  saving.value = true
  try {
    if (editing.value === 'new') {
      await api.post('/v1/workspaces/{id}/test-environments', { path: { id: props.workspaceId }, body: body() })
    } else {
      await api.patch('/v1/workspaces/{id}/test-environments/{environmentId}', {
        path: { id: props.workspaceId, environmentId: editing.value },
        body: body(),
      })
    }
    editing.value = null
    toast.success(t('qa.env.saved'))
    void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

async function remove(env: ApiTestEnvironment) {
  const ok = await confirm({
    title: t('qa.env.deleteTitle', { name: env.name }),
    description: t('qa.env.deleteBody'),
    action: t('qa.env.delete'),
    destructive: true,
  })
  if (!ok) return
  try {
    await api.delete('/v1/workspaces/{id}/test-environments/{environmentId}', { path: { id: props.workspaceId, environmentId: env.id } })
    void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <p class="kn-measure text-ui text-muted-foreground">
        {{ t('qa.env.intro') }}
        <template v-if="!runnerOn">
          {{ t('qa.env.runnerOff') }}
          <RouterLink v-if="auth.canAdminWorkspace" to="/settings/api" class="text-primary underline underline-offset-2">{{ t('qa.env.runnerSettings') }}</RouterLink>
        </template>
      </p>
      <Button v-if="canEdit && editing !== 'new'" size="sm" variant="outline" @click="open(null)">
        <Plus class="size-3.5" aria-hidden="true" /> {{ t('qa.env.add') }}
      </Button>
    </div>

    <PageState v-if="query.isPending.value" state="loading" :rows="2" row-class="h-14" />
    <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />

    <template v-else>
      <PageState
        v-if="!environments.length && editing !== 'new'"
        state="empty"
        :icon="Server"
        :title="t('qa.env.empty')"
        :description="canEdit ? t('qa.env.emptyHint') : t('qa.env.emptyReader')"
      />

      <ul v-if="environments.length || editing === 'new'" class="divide-y rounded-md border">
        <template v-for="env in [...environments, ...(editing === 'new' ? [null] : [])]" :key="env?.id ?? 'new'">
          <li v-if="editing !== (env?.id ?? 'new')" class="flex min-w-0 flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-4">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">{{ env!.name }}</p>
              <p class="text-ui text-muted-foreground font-mono [overflow-wrap:anywhere]">{{ env!.server ?? t('qa.env.specServer') }}</p>
              <p v-if="Object.keys(env!.inputs).length || env!.secrets.length" class="mt-1 flex flex-wrap gap-1.5">
                <code v-for="(value, name) in env!.inputs" :key="name" class="qa-chip">{{ name }} = {{ value }}</code>
                <code v-for="name in env!.secrets" :key="name" class="qa-chip">
                  <KeyRound class="size-3 shrink-0" aria-hidden="true" />{{ name }} <span class="text-muted-foreground">{{ t('qa.env.set') }}</span>
                </code>
              </p>
            </div>
            <div v-if="canEdit" class="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" @click="open(env)"><Pencil class="size-3.5" aria-hidden="true" /> {{ t('qa.env.edit') }}</Button>
              <Button size="icon-sm" variant="ghost" :aria-label="t('qa.env.deleteTitle', { name: env!.name })" @click="remove(env!)">
                <Trash2 class="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </li>

          <li v-else class="px-3 py-3">
            <form class="grid gap-4" @submit.prevent="save">
              <div class="grid gap-3 sm:grid-cols-2">
                <label class="grid gap-1">
                  <span class="text-caption text-muted-foreground font-medium">{{ t('qa.env.name') }}</span>
                  <Input v-model="draft.name" required maxlength="80" class="h-8 text-sm" />
                </label>
                <label class="grid gap-1">
                  <span class="text-caption text-muted-foreground font-medium">{{ t('qa.env.server') }}</span>
                  <Input v-model="draft.server" type="url" inputmode="url" placeholder="https://staging.example.com" spellcheck="false" class="h-8 font-mono text-sm" />
                </label>
              </div>
              <p class="text-caption text-muted-foreground -mt-2">{{ t('qa.env.serverHint') }}</p>

              <FixtureRows
                v-model="draft.inputs"
                :legend="t('qa.env.inputs')"
                name-placeholder="input.currency"
                :value-placeholder="t('qa.env.value')"
                :add-label="t('qa.env.addInput')"
                mono
              />

              <fieldset class="grid min-w-0 gap-1.5">
                <legend class="text-caption text-muted-foreground mb-1 font-medium">{{ t('qa.env.secrets') }}</legend>
                <p class="text-caption text-muted-foreground">{{ t('qa.env.secretsHint') }}</p>
                <div v-for="k in draft.kept" :key="k.name" class="flex min-w-0 items-center gap-1.5">
                  <code class="text-ui w-[38%] min-w-0 truncate font-mono" :class="k.remove && 'text-muted-foreground line-through'">{{ k.name }}</code>
                  <Input
                    v-model="k.replace"
                    type="password"
                    autocomplete="new-password"
                    :disabled="k.remove"
                    :placeholder="t('qa.env.replace')"
                    :aria-label="t('qa.env.replaceLabel', { name: k.name })"
                    class="h-8 min-w-0 flex-1 text-ui"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    class="text-muted-foreground size-8 shrink-0"
                    :aria-label="k.remove ? t('qa.env.keep', { name: k.name }) : t('qa.env.removeSecret', { name: k.name })"
                    :aria-pressed="k.remove"
                    @click="k.remove = !k.remove"
                  >
                    <Undo2 v-if="k.remove" class="size-3.5" aria-hidden="true" />
                    <Trash2 v-else class="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                <FixtureRows
                  v-model="draft.added"
                  :legend="t('qa.env.newSecrets')"
                  legend-hidden
                  name-placeholder="secret.qaPassword"
                  :value-placeholder="t('qa.env.value')"
                  :add-label="t('qa.env.addSecret')"
                  mono
                  secret
                />
              </fieldset>

              <div class="flex gap-2">
                <Button type="submit" size="sm" :disabled="saving || !draft.name.trim()">{{ t('qa.env.save') }}</Button>
                <Button type="button" size="sm" variant="ghost" @click="editing = null">{{ t('qa.env.cancel') }}</Button>
              </div>
            </form>
          </li>
        </template>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.qa-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  max-width: 100%;
  overflow-wrap: anywhere;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.05rem 0.35rem;
  font-size: var(--kn-text-caption);
  background: var(--card);
}
</style>
