<script setup lang="ts">
/**
 * The workspace's memo types (#879), for its admins: rename a built-in or
 * change how the agent treats it, hide one, add one of their own. Guidance
 * typed here becomes part of the agent's instructions for every member's
 * memos of that type, which is why the dialog says so and only admins see it.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { MEMO_TYPE_KEY_RE, type MemoType } from '@knowledge/contracts'
import { request } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { useProjectsStore } from '@/stores/projects'
import { useMemoTypes } from '../model/memo-types'

const props = defineProps<{ workspaceId: string }>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const queryClient = useQueryClient()
const { types, nameOf } = useMemoTypes(props.workspaceId)

const NEW = '+new'
const selected = ref<string>(NEW)
const name = ref('')
const guidance = ref('')
const hidden = ref(false)
/** Where a detected memo of this type goes, and whether it waits for its owner (#879, phase 2). */
const HERE = 'here'
const projects = useProjectsStore()
const project = ref(HERE)
const auto = ref(false)
const saving = ref(false)

const current = computed<MemoType | undefined>(() => types.value.find((type) => type.key === selected.value))

function load() {
  const type = current.value
  name.value = type ? (type.builtIn && !type.overridden ? '' : type.name) : ''
  guidance.value = type?.guidance ?? ''
  hidden.value = type?.hidden ?? false
  project.value = type?.projectId ?? HERE
  auto.value = type?.auto ?? false
}
watch(open, (now) => {
  if (!now) return
  selected.value = types.value[0]?.key ?? NEW
  load()
})
watch(selected, load)

/** A key from the name: latin letters, digits and dashes; anything else needs the person to rename. */
const newKey = computed(() =>
  name.value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40),
)
const keyOk = computed(() => selected.value !== NEW || (MEMO_TYPE_KEY_RE.test(newKey.value) && !types.value.some((type) => type.key === newKey.value)))
const canSave = computed(() => !saving.value && keyOk.value && (current.value?.builtIn || name.value.trim().length > 0))

async function run(call: () => Promise<unknown>, after?: () => void) {
  saving.value = true
  try {
    await call()
    await queryClient.invalidateQueries({ queryKey: ['/v1/memos/types'] })
    after?.()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

function save() {
  const key = selected.value === NEW ? newKey.value : selected.value
  return run(
    () =>
      request('put', '/v1/memos/types/{key}', {
        path: { key },
        body: { workspaceId: props.workspaceId, name: name.value.trim() || null, guidance: guidance.value.trim() || null, hidden: hidden.value, projectId: project.value === HERE ? null : project.value, auto: auto.value },
      }),
    () => {
      selected.value = key
      toast.success(t('memos.types.saved'))
    },
  )
}

function reset() {
  const key = selected.value
  return run(
    () => request('delete', '/v1/memos/types/{key}', { path: { key }, query: { workspaceId: props.workspaceId } }),
    () => {
      if (!current.value) selected.value = types.value[0]?.key ?? NEW
      load()
    },
  )
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('memos.types.title') }}</DialogTitle>
        <DialogDescription>{{ t('memos.types.description') }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="save">
        <div class="space-y-1.5">
          <Label for="memo-type-pick">{{ t('memos.types.pick') }}</Label>
          <Select v-model="selected">
            <SelectTrigger id="memo-type-pick" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="type in types" :key="type.key" :value="type.key">
                {{ nameOf(type) }}<template v-if="type.hidden"> · {{ t('memos.types.hiddenTag') }}</template>
              </SelectItem>
              <SelectItem :value="NEW">{{ t('memos.types.add') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="space-y-1.5">
          <Label for="memo-type-name">{{ t('memos.types.name') }}</Label>
          <Input id="memo-type-name" v-model="name" maxlength="80" autocomplete="off" :placeholder="current?.builtIn ? nameOf({ ...current, overridden: false }) : ''" />
          <p v-if="selected === NEW && name.trim() && !keyOk" role="alert" class="text-destructive text-xs">{{ t('memos.types.keyTaken') }}</p>
        </div>
        <div class="space-y-1.5">
          <Label for="memo-type-guidance">{{ t('memos.types.guidance') }}</Label>
          <Textarea id="memo-type-guidance" v-model="guidance" rows="6" maxlength="4000" />
          <p class="text-muted-foreground text-xs">{{ t('memos.types.guidanceHint') }}</p>
        </div>
        <div class="space-y-1.5">
          <Label for="memo-type-project">{{ t('memos.types.project') }}</Label>
          <Select v-model="project">
            <SelectTrigger id="memo-type-project" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="HERE">{{ t('memos.types.projectHere') }}</SelectItem>
              <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label class="flex items-start gap-2 text-sm">
          <Checkbox class="mt-0.5" :model-value="auto" @update:model-value="auto = $event === true" />
          {{ t('memos.types.auto') }}
        </label>
        <label class="flex items-center gap-2 text-sm">
          <Checkbox :model-value="hidden" @update:model-value="hidden = $event === true" />
          {{ t('memos.types.hide') }}
        </label>
        <DialogFooter>
          <Button v-if="current && (!current.builtIn || current.overridden || current.hidden)" type="button" variant="ghost" :disabled="saving" @click="reset">
            {{ current.builtIn ? t('memos.types.reset') : t('memos.types.remove') }}
          </Button>
          <Button type="submit" :disabled="!canSave">{{ t('memos.actions.save') }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
