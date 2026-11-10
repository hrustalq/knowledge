<script setup lang="ts">
/**
 * Plaud auto-import settings (#864): where picked recordings go and which
 * ones are picked. The defaults are shown as values, so the form says what
 * applies and not only what was typed. Unlinking lives here too: it is the
 * same decision turned all the way off.
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { PlaudSettingsResponse } from '@knowledge/contracts'
import { request } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/shared/ui/button'
import { confirm } from '@/shared/ui/confirm'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { RadioGroup, RadioGroupItem } from '@/shared/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { fromRulesForm, toRulesForm, type PlaudRulesForm } from '../model/plaud-ui'

const props = defineProps<{ workspaceId: string; settings: PlaudSettingsResponse; accountLabel: string | null }>()
const emit = defineEmits<{ saved: []; unlinked: [] }>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const projects = useProjectsStore()
/** The select cannot hold null, so "off" has its own value. */
const OFF = 'off'
const form = ref<PlaudRulesForm>(toRulesForm(null, {}, props.settings.effective))
const project = ref(OFF)
const saving = ref(false)
const invalidLength = ref(false)

watch(open, (now) => {
  if (!now) return
  // A first visit proposes the project the person is working in.
  form.value = toRulesForm(props.settings.projectId, props.settings.rules, props.settings.effective)
  project.value = props.settings.projectId ?? projects.activeId ?? OFF
  invalidLength.value = false
})

async function save() {
  const rules = fromRulesForm(form.value)
  invalidLength.value = rules === null
  if (!rules) return
  saving.value = true
  try {
    await request('put', '/v1/plaud/settings', {
      body: { workspaceId: props.workspaceId, projectId: project.value === OFF ? null : project.value, rules },
    })
    emit('saved')
    open.value = false
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

async function unlink() {
  const ok = await confirm({
    title: t('memos.plaud.unlink.title'),
    description: t('memos.plaud.unlink.body'),
    action: t('memos.plaud.unlink.action'),
    destructive: true,
  })
  if (!ok) return
  try {
    await request('delete', '/v1/plaud/link', { query: { workspaceId: props.workspaceId } })
    emit('unlinked')
    open.value = false
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('memos.plaud.rules.title') }}</DialogTitle>
        <DialogDescription>{{ t('memos.plaud.rules.desc') }}</DialogDescription>
      </DialogHeader>

      <form id="plaud-rules" class="space-y-4" @submit.prevent="save">
        <div class="space-y-1.5">
          <Label for="plaud-project">{{ t('memos.plaud.rules.project') }}</Label>
          <Select v-model="project">
            <SelectTrigger id="plaud-project" class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="OFF">{{ t('memos.plaud.rules.projectOff') }}</SelectItem>
              <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-muted-foreground text-xs">{{ t('memos.plaud.rules.projectHint') }}</p>
        </div>

        <fieldset :disabled="project === OFF" class="space-y-4 disabled:opacity-60">
          <div class="grid items-start gap-4 sm:grid-cols-2">
            <div class="space-y-1.5">
              <Label for="plaud-since">{{ t('memos.plaud.rules.since') }}</Label>
              <Input id="plaud-since" v-model="form.since" type="date" required aria-describedby="plaud-since-hint" />
              <p id="plaud-since-hint" class="text-muted-foreground text-xs">{{ t('memos.plaud.rules.sinceHint') }}</p>
            </div>
            <div class="space-y-1.5">
              <Label for="plaud-min">{{ t('memos.plaud.rules.minLength') }}</Label>
              <Input
                id="plaud-min"
                v-model="form.minMinutes"
                inputmode="decimal"
                :aria-invalid="invalidLength || undefined"
                :aria-describedby="invalidLength ? 'plaud-min-error' : undefined"
              />
              <p v-if="invalidLength" id="plaud-min-error" class="text-destructive text-xs">{{ t('memos.plaud.rules.minLengthInvalid') }}</p>
            </div>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-1.5">
              <Label for="plaud-includes">{{ t('memos.plaud.rules.nameIncludes') }}</Label>
              <Input id="plaud-includes" v-model="form.nameIncludes" maxlength="200" :placeholder="t('memos.plaud.rules.anyName')" />
            </div>
            <div class="space-y-1.5">
              <Label for="plaud-excludes">{{ t('memos.plaud.rules.nameExcludes') }}</Label>
              <Input id="plaud-excludes" v-model="form.nameExcludes" maxlength="200" :placeholder="t('memos.plaud.rules.nothing')" />
            </div>
          </div>

          <div class="space-y-1.5">
            <Label for="plaud-serial">{{ t('memos.plaud.rules.serial') }}</Label>
            <Input id="plaud-serial" v-model="form.serial" maxlength="100" :placeholder="t('memos.plaud.rules.anyDevice')" />
          </div>

          <div class="space-y-2">
            <p id="plaud-confirm-label" class="text-sm font-medium">{{ t('memos.plaud.rules.confirm') }}</p>
            <!-- Two options whose consequences differ: one spends on its own, one waits. Both are spelled out. -->
            <RadioGroup v-model="form.confirm" aria-labelledby="plaud-confirm-label" class="gap-2">
              <label v-for="mode in ['ask', 'auto'] as const" :key="mode" class="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 has-[:checked]:border-primary has-[[data-state=checked]]:border-primary">
                <RadioGroupItem :value="mode" class="mt-0.5" />
                <span class="min-w-0">
                  <span class="block text-sm font-medium">{{ t(`memos.plaud.rules.mode.${mode}.label`) }}</span>
                  <span class="text-muted-foreground block text-xs">{{ t(`memos.plaud.rules.mode.${mode}.desc`, { count: settings.maxPerDay }) }}</span>
                </span>
              </label>
            </RadioGroup>
          </div>
        </fieldset>
      </form>

      <DialogFooter class="gap-2 sm:justify-between">
        <Button type="button" variant="ghost" class="text-destructive hover:text-destructive" @click="unlink">
          {{ t('memos.plaud.unlink.action') }}
        </Button>
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" @click="open = false">{{ t('memos.plaud.cancel') }}</Button>
          <Button type="submit" form="plaud-rules" :disabled="saving">{{ t('memos.plaud.rules.save') }}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
