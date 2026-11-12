<script setup lang="ts">
/**
 * "Save as blueprint" (#716): the wizard's edited blueprint, or — from a
 * project's settings — one derived from that project, kept as a workspace row
 * every editor is offered under Start.
 *
 * The wizard is the only blueprint editor, so this is also how a blueprint
 * changes: started from a saved one, Save can update it (a new version);
 * started from a built-in, it can replace that built-in for this workspace
 * (an override row; Reset in settings brings the original back).
 *
 * Admin only, as the routes are: a blueprint changes what every editor in
 * the workspace starts from.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Loader2 } from 'lucide-vue-next'
import { blueprintText, isBuiltInBlueprintKey, type Blueprint, type BlueprintEntry, type Locale } from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { Label } from '@knowledge/ui/label'
import { Textarea } from '@knowledge/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@knowledge/ui/radio-group'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@knowledge/ui/dialog'
import BlueprintTreePreview from '@/modules/projects/components/BlueprintTreePreview.vue'
import { cloneJson, countPages, typedText } from '@/modules/projects/model/blueprint-tree'
import type { ScaffoldOrigin } from '@/modules/projects/model/scaffold-machine'

const props = defineProps<{
  locale: Locale
  /** The blueprint to save (the wizard). */
  blueprint?: Blueprint | null
  /** Or a project to derive it from first (project settings). */
  projectId?: string
  origin?: ScaffoldOrigin | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [BlueprintEntry] }>()

const { t } = useI18n()
const router = useRouter()

const derived = ref<{ blueprint: Blueprint; drafted: boolean } | null>(null)
const deriveError = ref<string | null>(null)
const source = computed(() => props.blueprint ?? derived.value?.blueprint ?? null)

const listed = computed(() => (props.origin?.kind === 'blueprint' ? props.origin : null))
type Mode = 'new' | 'replace'
const mode = ref<Mode>('new')
const name = ref('')
const description = ref('')
const saving = ref(false)

async function derive() {
  if (!props.projectId) return
  derived.value = null
  deriveError.value = null
  try {
    const res = await api.post('/v1/blueprints/derive', { body: { workspaceId: getWorkspaceId(), projectId: props.projectId } })
    derived.value = { blueprint: res.blueprint, drafted: res.drafted }
    seed()
  } catch (e) {
    deriveError.value = errorMessage(e, t)
  }
}

function seed() {
  name.value = blueprintText(source.value?.name, props.locale)
  description.value = blueprintText(source.value?.description, props.locale)
}

watch(open, (isOpen) => {
  if (!isOpen) return
  // Updating what you started from is the likelier intent than a near-copy.
  mode.value = listed.value ? 'replace' : 'new'
  seed()
  if (props.projectId) void derive()
})

/** Typed text replaces every language; untouched text keeps the ones it had. */
function text(typed: string, original: Blueprint['name'] | undefined) {
  const value = typed.trim()
  if (!value) return undefined
  return value === blueprintText(original, props.locale).trim() ? original : typedText(props.locale, value)
}

const canSave = computed(() => !!source.value?.tree.length && !!name.value.trim() && !saving.value)

async function save() {
  const base = source.value
  if (!base || !canSave.value) return
  saving.value = true
  const next = cloneJson(base)
  next.name = text(name.value, base.name)!
  const desc = text(description.value, base.description)
  if (desc) next.description = desc
  else delete next.description
  // The DTO cannot name the contracts type; the server parses it with the one schema.
  const blueprint = next as unknown as Record<string, unknown>
  const target = mode.value === 'replace' ? listed.value : null
  try {
    const entry = target?.id
      ? await api.patch('/v1/blueprints/{id}', { path: { id: target.id }, body: { blueprint } })
      : await api.post('/v1/blueprints', {
          body: { workspaceId: getWorkspaceId(), blueprint, ...(target?.builtIn && isBuiltInBlueprintKey(target.key) ? { builtInKey: target.key } : {}) },
        })
    open.value = false
    emit('saved', entry)
    toast.success(t(target ? 'blueprints.save.updated' : 'blueprints.save.saved', { name: name.value.trim() }), {
      action: { label: t('blueprints.save.openSettings'), onClick: () => void router.push(`/settings/blueprints/${encodeURIComponent(entry.key)}`) },
    })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

const pages = computed(() => countPages(source.value?.tree ?? []))
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-lg">
      <DialogHeader class="border-b px-5 pt-5 pb-3">
        <DialogTitle>{{ projectId ? t('blueprints.save.fromProjectTitle') : t('blueprints.save.title') }}</DialogTitle>
        <DialogDescription>{{ t('blueprints.save.description') }}</DialogDescription>
      </DialogHeader>

      <form id="kn-save-blueprint" class="min-h-0 space-y-4 overflow-y-auto px-5 py-4" @submit.prevent="save">
        <template v-if="projectId">
          <div v-if="deriveError" role="alert" class="rounded-lg border p-3 text-sm">
            <p>{{ t('scaffold.derive.failed') }}</p>
            <p class="text-muted-foreground mt-1 text-xs">{{ deriveError }}</p>
            <Button size="sm" variant="outline" class="mt-2" type="button" @click="derive">{{ t('common.retry') }}</Button>
          </div>
          <p v-else-if="!derived" class="text-muted-foreground flex items-center gap-2 text-sm" aria-live="polite">
            <Loader2 class="size-4 animate-spin" /> {{ t('scaffold.derive.reading') }}
          </p>
        </template>

        <p v-if="source && !source.tree.length" role="alert" class="rounded-lg border px-3 py-2 text-sm">{{ t('scaffold.derive.empty') }}</p>
        <template v-else-if="source">
          <RadioGroup v-if="listed" v-model="mode" class="gap-2" :aria-label="t('blueprints.save.modeLabel')">
            <label class="flex items-start gap-2 text-sm">
              <RadioGroupItem value="replace" class="mt-0.5" />
              <span>
                {{ listed.builtIn ? t('blueprints.save.replaceBuiltIn') : t('blueprints.save.update') }}
                <span class="text-muted-foreground block text-xs">
                  {{ listed.builtIn ? t('blueprints.save.replaceBuiltInHint') : t('blueprints.save.updateHint') }}
                </span>
              </span>
            </label>
            <label class="flex items-start gap-2 text-sm">
              <RadioGroupItem value="new" class="mt-0.5" />
              <span>{{ t('blueprints.save.asNew') }}</span>
            </label>
          </RadioGroup>

          <div class="space-y-1.5">
            <Label for="kn-sbp-name">{{ t('blueprints.fields.name') }}</Label>
            <Input id="kn-sbp-name" v-model="name" maxlength="120" required autocomplete="off" />
          </div>
          <div class="space-y-1.5">
            <Label for="kn-sbp-description">{{ t('blueprints.fields.description') }} <span class="text-muted-foreground font-normal">{{ t('nav.optionalSuffix') }}</span></Label>
            <Textarea id="kn-sbp-description" v-model="description" rows="2" maxlength="2000" />
          </div>

          <div class="space-y-1.5">
            <p class="text-muted-foreground text-xs font-medium">
              {{ t('scaffold.create.summaryPages', { count: pages }, pages) }}
            </p>
            <div class="max-h-56 overflow-y-auto rounded-lg border px-3 py-2">
              <BlueprintTreePreview :tree="source.tree" :locale="locale" />
            </div>
            <p v-if="derived" class="text-muted-foreground text-caption leading-snug">
              {{ derived.drafted ? t('scaffold.provenance.drafted') : t('scaffold.provenance.rulesOnly') }}
            </p>
          </div>
        </template>
      </form>

      <DialogFooter class="border-t px-5 py-3">
        <Button variant="ghost" :disabled="saving" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button type="submit" form="kn-save-blueprint" :disabled="!canSave">
          <Loader2 v-if="saving" class="size-4 animate-spin" />
          {{ saving ? t('common.saving') : mode === 'replace' && listed ? t('blueprints.save.saveChanges') : t('blueprints.save.save') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
