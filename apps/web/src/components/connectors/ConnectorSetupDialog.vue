<script setup lang="ts">
/**
 * Connector setup as a guided scenario (docs/features/19).
 *
 * This replaced a single long form. The form asked for everything at once and
 * could not say which half the credential had to be right for, so the only way
 * to find out you had mistyped a token was to save and watch a red row appear
 * in a list. The scenario asks one thing at a time, proves the connection
 * before asking anything that depends on it, and only then asks what the
 * connection should *do* — which is the question the whole setup exists for.
 *
 * All flow control lives in `setup-machines.ts`: this file renders the current
 * state and sends events. It never decides what comes next, which is why the
 * per-connector differences (Confluence has a space, Notion does not) cost
 * nothing here.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQueryClient } from '@tanstack/vue-query'
import { ArrowLeft, Check, CircleAlert, History, Loader2, Plug, X } from 'lucide-vue-next'
import { CONNECTOR_KIND_INFO, connectorKindInfo } from '@knowledge/contracts'
import type {
  ConnectorConflictPolicy,
  ConnectorDirection,
  ConnectorKind,
  ConnectorSummary,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import ImportStepper from '@/components/import/ImportStepper.vue'
import { getWorkspaceId } from '@/lib/api'
import { useProjectsStore } from '@/stores/projects'
import {
  clearSetup,
  createSetupActor,
  kindStepMeta,
  loadSetup,
  saveSetup,
  stepIndex,
  stepLabels,
  type SetupContext,
} from './setup-machines'

const props = defineProps<{ open: boolean; editing: ConnectorSummary | null }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const { t } = useI18n()
const projects = useProjectsStore()
const queryClient = useQueryClient()
const workspaceId = getWorkspaceId()

const kind = ref<ConnectorKind>('confluence')
/** shallowRef: the actor is a live object, not reactive data to be proxied. */
const actor = shallowRef<ReturnType<typeof createSetupActor> | null>(null)
const state = ref<string>('naming')
const childStep = ref<string | null>(null)
const context = ref<SetupContext | null>(null)
/**
 * True when this dialog opened onto a setup someone had already started —
 * closed with the X, or with the tab. Without saying so, the wizard reopens
 * mid-flow with fields already filled and no explanation, which reads as a bug.
 */
const resumed = ref(false)

const info = computed(() => connectorKindInfo(kind.value))
const labels = computed(() => stepLabels(kind.value).map((key) => t(key)))
const current = computed(() => stepIndex(kind.value, state.value, childStep.value))
/** Which config fields the current sub-step is asking for. */
const stepMeta = computed(() => kindStepMeta(kind.value, childStep.value))
const fieldsFor = computed(() =>
  (stepMeta.value?.fields ?? [])
    .map((key) => info.value?.fields.find((f) => f.key === key))
    .filter((f): f is NonNullable<typeof f> => !!f),
)

// --- the services the machine invokes ------------------------------------

async function testConnection(ctx: SetupContext) {
  // Testing needs a connector row, so an unsaved setup saves a disabled draft
  // first. That is also what makes the flow resumable server-side: from here on
  // the setup has an id, not just a snapshot.
  const id = ctx.connectorId ?? ctx.editingId ?? (await saveConnector(ctx, true))
  const res = (await api.post('/v1/connectors/{id}/test', { path: { id } })) as {
    ok: boolean
    detail: string | null
  }
  if (actor.value) actor.value.send({ type: 'SET', patch: { connectorId: id } })
  return res
}

async function saveConnector(ctx: SetupContext, draft = false): Promise<string> {
  const body = {
    name: ctx.name.trim(),
    config: ctx.config,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    ...(ctx.credential ? { credential: ctx.credential } : {}),
    ...(draft
      ? // A draft exists only so the connection can be tested; it must not sync.
        { enabled: false }
      : {
          enabled: true,
          direction: ctx.direction,
          conflict: ctx.conflict,
          pushOnPublish: ctx.pushOnPublish,
          syncIntervalMinutes: ctx.syncIntervalMinutes,
          category: ctx.category,
          ...(ctx.webhookSecret ? { webhookSecret: ctx.webhookSecret } : {}),
        }),
  }

  const existing = ctx.connectorId ?? ctx.editingId
  if (existing) {
    await api.patch('/v1/connectors/{id}', { path: { id: existing }, body })
    await queryClient.invalidateQueries({ queryKey: ['/v1/connectors'] })
    return existing
  }
  const res = (await api.post('/v1/connectors', {
    body: {
      workspaceId,
      kind: kind.value,
      // A draft needs a project even though it will not sync; the first one is
      // a placeholder the destination step replaces.
      projectId: ctx.projectId || projects.activeId || projects.items[0]?.projectId || '',
      ...body,
    },
  })) as { connector: { id: string } }
  await queryClient.invalidateQueries({ queryKey: ['/v1/connectors'] })
  return res.connector.id
}

// --- actor lifecycle ------------------------------------------------------

let unsubscribe: (() => void) | null = null

function boot(resume: boolean) {
  unsubscribe?.()
  actor.value?.stop()

  const editing = props.editing
  const snapshot = resume && !editing ? loadSetup(kind.value) : undefined
  // Only worth announcing if there is progress to announce: a snapshot parked
  // on the first question with nothing typed is not something to resume.
  resumed.value = !!snapshot && !isUntouched(snapshot)

  const next = createSetupActor(
    kind.value,
    {
      kind: kind.value,
      ...(editing
        ? {
            name: editing.name,
            config: { ...editing.config },
            projectId: editing.projectId,
            parentId: editing.parentId,
            category: editing.category,
            direction: editing.direction,
            conflict: editing.conflict,
            syncIntervalMinutes: editing.syncIntervalMinutes,
            pushOnPublish: editing.pushOnPublish,
            editingId: editing.id,
          }
        : {}),
    },
    { test: testConnection, save: (ctx) => saveConnector(ctx) },
    snapshot,
  )

  const sub = next.subscribe((snap) => {
    state.value = String(snap.value)
    context.value = snap.context
    const child = (snap.children as Record<string, { getSnapshot(): { value: string } } | undefined>).kind
    childStep.value = child ? String(child.getSnapshot().value) : null

    // Persisted on every transition, so a reload lands back on this step.
    if (snap.status === 'done') {
      clearSetup()
      toast.success(t('connectors.added'))
      emit('update:open', false)
    } else if (!props.editing) {
      saveSetup(next.getPersistedSnapshot())
    }
  })
  unsubscribe = () => sub.unsubscribe()
  next.start()
  actor.value = next
}

watch(
  () => [props.open, props.editing] as const,
  ([open, editing]) => {
    if (!open) return
    if (!projects.loaded) void projects.fetchList()
    kind.value = editing ? editing.kind : kind.value
    boot(!editing)
  },
  { immediate: true },
)

// Switching the kind rebuilds the flow: a different system asks different
// questions, so keeping the old answers would be keeping the wrong ones.
/** A snapshot still on the opening question with an empty name. */
function isUntouched(snapshot: ReturnType<typeof loadSetup>): boolean {
  const snap = snapshot as { value?: unknown; context?: { name?: string } } | undefined
  return snap?.value === 'naming' && !snap?.context?.name
}

function pickKind(next: ConnectorKind) {
  if (next === kind.value) return
  kind.value = next
  clearSetup()
  boot(false)
}

onBeforeUnmount(() => {
  unsubscribe?.()
  actor.value?.stop()
})

// --- sending --------------------------------------------------------------

const send = (event: Parameters<NonNullable<typeof actor.value>['send']>[0]) => actor.value?.send(event)
const setField = (key: string, value: string) => send({ type: 'SET_FIELD', key, value })
const patch = (p: Partial<SetupContext>) => send({ type: 'SET', patch: p })

const busy = computed(() => state.value === 'testing' || state.value === 'saving')

function close() {
  // The snapshot is deliberately kept: reopening resumes where you stopped.
  emit('update:open', false)
}

function startOver() {
  clearSetup()
  boot(false)
  resumed.value = false
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{{ editing ? t('connectors.editTitle') : t('connectors.addTitle') }}</DialogTitle>
        <DialogDescription>{{ t('connectors.dialogHint') }}</DialogDescription>
      </DialogHeader>

      <!-- Closing this dialog keeps the setup rather than discarding it, so
           reopening has to say so — and offer the way out of it. -->
      <div
        v-if="resumed"
        class="border-primary/30 bg-primary/5 flex items-start gap-2 rounded-md border px-3 py-2"
        role="status"
      >
        <History class="text-primary mt-0.5 size-3.5 shrink-0" />
        <p class="min-w-0 flex-1 text-xs">
          {{ t('connectors.resumed') }}
          <button
            type="button"
            class="text-primary underline underline-offset-2"
            @click="startOver"
          >
            {{ t('connectors.startOver') }}
          </button>
        </p>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground shrink-0"
          :aria-label="t('common.close')"
          @click="resumed = false"
        >
          <X class="size-3.5" />
        </button>
      </div>

      <!-- The flow's length is a fact about the system being connected, so the
           stepper is built from the chosen kind's own steps. -->
      <ImportStepper :current="current" :steps="labels" :label="t('connectors.steps')" class="overflow-x-auto pb-1" />

      <div class="min-h-[13rem] py-1">
        <!-- 1 · Name and system ------------------------------------------->
        <div v-if="state === 'naming'" class="space-y-4">
          <label class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.kind') }}</span>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="k in CONNECTOR_KIND_INFO"
                :key="k.kind"
                type="button"
                :aria-pressed="kind === k.kind"
                :disabled="!!editing"
                class="focus-visible:ring-ring rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                :class="kind === k.kind ? 'border-primary text-primary bg-primary/5 font-medium' : 'hover:border-border'"
                @click="pickKind(k.kind)"
              >
                {{ k.label }}
                <span class="text-muted-foreground mt-0.5 block text-xs font-normal">
                  {{ k.capabilities.push ? t('connectors.directionBoth') : t('connectors.directionPull') }}
                </span>
              </button>
            </div>
          </label>

          <label class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.name') }}</span>
            <Input
              :model-value="context?.name ?? ''"
              :placeholder="t('connectors.namePlaceholder')"
              autofocus
              @update:model-value="patch({ name: String($event) })"
            />
            <span class="text-muted-foreground block text-xs">{{ t('connectors.nameHint') }}</span>
          </label>
        </div>

        <!-- 2..n · The kind's own questions -------------------------------->
        <div v-else-if="state === 'configuring'" class="space-y-4">
          <label v-for="field in fieldsFor" :key="field.key" class="block space-y-1.5">
            <span class="text-sm font-medium">
              {{ field.label }}
              <span v-if="!field.required" class="text-muted-foreground font-normal">
                — {{ t('connectors.optional') }}
              </span>
            </span>
            <Input
              :model-value="context?.config[field.key] ?? ''"
              :placeholder="field.placeholder"
              @update:model-value="setField(field.key, String($event))"
            />
            <span v-if="field.help" class="text-muted-foreground block text-xs">{{ field.help }}</span>
          </label>

          <label v-if="stepMeta?.credential" class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.credential') }}</span>
            <Input
              :model-value="context?.credential ?? ''"
              type="password"
              autocomplete="off"
              :placeholder="editing?.hasCredential ? t('connectors.credentialKeep', { hint: editing.credentialHint ?? '' }) : (info?.credentialLabel ?? '')"
              @update:model-value="patch({ credential: String($event) })"
            />
            <span class="text-muted-foreground block text-xs">{{ t('connectors.credentialHint') }}</span>
          </label>
        </div>

        <!-- Testing: the step that earns the rest of the flow --------------->
        <div v-else-if="state === 'testing'" class="flex flex-col items-center justify-center py-10 text-center">
          <Loader2 class="text-primary size-6 animate-spin" />
          <p class="mt-3 text-sm font-medium">{{ t('connectors.testing') }}</p>
          <p class="text-muted-foreground mt-1 text-xs">{{ t('connectors.testingHint') }}</p>
        </div>

        <div v-else-if="state === 'testFailed'" class="space-y-4">
          <div class="border-destructive/40 bg-destructive/5 rounded-md border p-4">
            <div class="flex items-start gap-2">
              <CircleAlert class="text-destructive mt-0.5 size-4 shrink-0" />
              <div class="min-w-0">
                <p class="text-sm font-medium">{{ t('connectors.testFailed') }}</p>
                <p class="text-muted-foreground mt-1 text-xs break-words">{{ context?.error }}</p>
              </div>
            </div>
          </div>
          <p class="text-muted-foreground text-xs">{{ t('connectors.testFailedHint') }}</p>
        </div>

        <!-- Destination ---------------------------------------------------->
        <div v-else-if="state === 'destination'" class="space-y-4">
          <div v-if="context?.testDetail" class="flex items-center gap-2 text-sm">
            <Check class="size-4 text-emerald-600 dark:text-emerald-500" />
            <span>{{ t('connectors.connected', { detail: context.testDetail }) }}</span>
          </div>

          <label class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.project') }}</span>
            <Select
              :model-value="context?.projectId ?? ''"
              @update:model-value="patch({ projectId: String($event) })"
            >
              <SelectTrigger><SelectValue :placeholder="t('connectors.projectPlaceholder')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">
                  {{ p.name }}
                </SelectItem>
              </SelectContent>
            </Select>
            <span class="text-muted-foreground block text-xs">{{ t('connectors.projectHint') }}</span>
          </label>
        </div>

        <!-- What should it do ---------------------------------------------->
        <div v-else-if="state === 'options' || state === 'saving'" class="space-y-4">
          <label class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.direction') }}</span>
            <Select :model-value="context?.direction ?? 'pull'" @update:model-value="patch({ direction: $event as ConnectorDirection })">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pull">{{ t('connectors.directionPull') }}</SelectItem>
                <SelectItem v-if="info?.capabilities.push" value="push">{{ t('connectors.directionPush') }}</SelectItem>
                <SelectItem v-if="info?.capabilities.push" value="both">{{ t('connectors.directionBoth') }}</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.conflict') }}</span>
            <Select :model-value="context?.conflict ?? 'manual'" @update:model-value="patch({ conflict: $event as ConnectorConflictPolicy })">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">{{ t('connectors.conflictManual') }}</SelectItem>
                <SelectItem value="external-wins">{{ t('connectors.conflictExternal') }}</SelectItem>
                <SelectItem value="local-wins">{{ t('connectors.conflictLocal') }}</SelectItem>
              </SelectContent>
            </Select>
            <span class="text-muted-foreground block text-xs">{{ t('connectors.conflictHint') }}</span>
          </label>

          <label class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.interval') }}</span>
            <Input
              :model-value="context?.syncIntervalMinutes ?? ''"
              type="number"
              min="5"
              max="10080"
              :placeholder="t('connectors.intervalManual')"
              @update:model-value="patch({ syncIntervalMinutes: $event === '' ? null : Number($event) })"
            />
            <span class="text-muted-foreground block text-xs">{{ t('connectors.intervalHint') }}</span>
          </label>

          <label v-if="info?.capabilities.push" class="flex items-start gap-2">
            <Checkbox
              :model-value="context?.pushOnPublish ?? false"
              class="mt-0.5"
              @update:model-value="patch({ pushOnPublish: !!$event })"
            />
            <span class="text-sm">
              {{ t('connectors.pushOnPublish') }}
              <span class="text-muted-foreground block text-xs">{{ t('connectors.pushOnPublishHint') }}</span>
            </span>
          </label>

          <p v-if="context?.error" class="text-destructive text-xs">{{ context.error }}</p>
        </div>
      </div>

      <!-- One action bar for every step, so the primary action never moves. -->
      <div class="flex items-center justify-between gap-3 border-t pt-4">
        <Button
          v-if="state !== 'naming' && state !== 'testing'"
          type="button"
          variant="ghost"
          size="sm"
          @click="send({ type: 'BACK' })"
        >
          <ArrowLeft class="size-3.5" /> {{ t('common.back') }}
        </Button>
        <button
          v-else-if="!editing && context?.name"
          type="button"
          class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
          @click="startOver"
        >
          {{ t('connectors.startOver') }}
        </button>
        <span v-else />

        <div class="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" @click="close">{{ t('common.cancel') }}</Button>

          <template v-if="state === 'testFailed'">
            <Button type="button" variant="outline" size="sm" @click="send({ type: 'SKIP_TEST' })">
              {{ t('connectors.continueAnyway') }}
            </Button>
            <Button type="button" size="sm" @click="send({ type: 'RETRY' })">{{ t('common.retry') }}</Button>
          </template>

          <Button
            v-else-if="state === 'options' || state === 'saving'"
            type="button"
            size="sm"
            :disabled="busy"
            @click="send({ type: 'SUBMIT' })"
          >
            <Loader2 v-if="state === 'saving'" class="size-3.5 animate-spin" />
            <Plug v-else class="size-3.5" />
            {{ editing ? t('common.save') : t('connectors.finish') }}
          </Button>

          <Button v-else type="button" size="sm" :disabled="busy" @click="send({ type: 'NEXT' })">
            {{ t('common.next') }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
