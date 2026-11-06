<script setup lang="ts">
/**
 * Asks a provider what it serves and adds the ones ticked.
 *
 * A dialog rather than a row of the list because an aggregator answers with
 * hundreds. Nothing joins the workspace until it is ticked, and many
 * OpenAI-compatible servers have no list at all, so a refusal is an ordinary
 * outcome: it shows the upstream's own words and points back at typing a code.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { api } from '@/shared/api/client'
import { useApiMutation } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Skeleton } from '@/shared/ui/skeleton'

const props = defineProps<{
  /** Null asks the default config. */
  providerId: string | null
  title: string
  /** Codes this provider already has: shown ticked and locked. */
  existing: string[]
}>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const workspaceId = getWorkspaceId()
const add = useApiMutation('post', '/v1/ai/models', {
  invalidates: () => [['/v1/ai/models'], ['/v1/ai/models/choices']],
})

const loading = ref(false)
const failure = ref<string | null>(null)
const codes = ref<string[]>([])
const filter = ref('')
const ticked = ref(new Set<string>())

const have = computed(() => new Set(props.existing))
const shown = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  return needle ? codes.value.filter((code) => code.toLowerCase().includes(needle)) : codes.value
})
const canTick = computed(() => shown.value.filter((code) => !have.value.has(code)))

watch(open, async (isOpen) => {
  if (!isOpen) return
  loading.value = true
  failure.value = null
  codes.value = []
  filter.value = ''
  ticked.value = new Set()
  try {
    const result = await api.post('/v1/ai/models/discover', {
      body: { workspaceId, ...(props.providerId ? { providerId: props.providerId } : {}) },
    })
    codes.value = result.codes
    if (!result.ok) failure.value = result.error ?? t('ai.models.fetchFailed')
  } catch (e) {
    failure.value = errorMessage(e, t)
  } finally {
    loading.value = false
  }
})

function toggle(code: string, on: boolean) {
  const next = new Set(ticked.value)
  if (on) next.add(code)
  else next.delete(code)
  ticked.value = next
}

async function submit() {
  try {
    await add.mutateAsync({ body: { workspaceId, providerId: props.providerId, codes: [...ticked.value], source: 'fetched' } })
    toast.success(t('count.modelsAdded', { n: ticked.value.size }, ticked.value.size))
    open.value = false
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[90dvh] flex-col sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('ai.models.fetchTitle', { name: title }) }}</DialogTitle>
        <DialogDescription>{{ t('ai.models.fetchDesc') }}</DialogDescription>
      </DialogHeader>

      <div v-if="loading" class="space-y-2" aria-hidden="true">
        <Skeleton v-for="n in 5" :key="n" class="h-4 w-3/4" />
      </div>

      <div v-else-if="failure" role="alert" class="space-y-1 text-sm">
        <p>{{ t('ai.models.fetchRefused') }}</p>
        <p class="text-destructive text-xs break-words">{{ failure }}</p>
      </div>

      <p v-else-if="!codes.length" class="text-sm">{{ t('ai.models.fetchEmpty') }}</p>

      <template v-else>
        <div class="flex items-center gap-2">
          <Input v-model="filter" type="search" :placeholder="t('ai.models.filter')" :aria-label="t('ai.models.filter')" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="shrink-0"
            :disabled="!canTick.length"
            @click="ticked = new Set([...ticked, ...canTick])"
          >
            {{ t('ai.models.tickShown') }}
          </Button>
        </div>
        <ul class="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border">
          <li v-for="code in shown" :key="code">
            <label class="flex items-start gap-2 px-3 py-1.5 text-sm" :class="have.has(code) ? 'text-muted-foreground' : 'hover:bg-accent/50'">
              <Checkbox
                class="mt-0.5"
                :model-value="have.has(code) || ticked.has(code)"
                :disabled="have.has(code)"
                @update:model-value="toggle(code, $event === true)"
              />
              <span class="min-w-0 break-all font-mono text-xs leading-5">{{ code }}</span>
            </label>
          </li>
          <li v-if="!shown.length" class="text-muted-foreground px-3 py-3 text-sm">{{ t('ai.models.filterEmpty') }}</li>
        </ul>
      </template>

      <DialogFooter>
        <Button type="button" variant="outline" size="sm" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button v-if="codes.length" type="button" size="sm" :disabled="!ticked.size || add.isPending.value" @click="submit">
          {{ t('count.addModels', { n: ticked.size }, ticked.size) }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
