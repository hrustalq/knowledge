<script setup lang="ts">
/**
 * What one provider serves: each model's code, the work it runs, its price, and
 * whether members may pick it. A native disclosure, because a well-stocked
 * aggregator should not push the next provider off the screen.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Trash2 } from 'lucide-vue-next'
import { useApiMutation } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { Checkbox } from '@knowledge/ui/checkbox'
import { confirm } from '@knowledge/ui/confirm'
import { Input } from '@knowledge/ui/input'
import { formatPrice } from '@/shared/utils/format'
import type { AiModelSummary } from '@knowledge/contracts'
import type { ModelRow, ProviderRow } from '@/modules/assistant/model/provider-rows'
import AiModelDialog from './AiModelDialog.vue'
import AiModelFetchDialog from './AiModelFetchDialog.vue'

const props = defineProps<{ row: ProviderRow; title: string; canManage: boolean }>()
defineEmits<{ editProvider: [] }>()

const { t } = useI18n()
const workspaceId = getWorkspaceId()

const invalidates = () => [['/v1/ai/models'], ['/v1/ai/models/choices'], ['/v1/ai/settings']]
const add = useApiMutation('post', '/v1/ai/models', { invalidates })
const update = useApiMutation('patch', '/v1/ai/models/{id}', { invalidates })
const remove = useApiMutation('delete', '/v1/ai/models/{id}', { invalidates })

/** Above this the list starts closed: it is a reference, and the page is a list of providers. */
const OPEN_UP_TO = 5
const off = computed(() => !props.row.enabled)
const providerId = computed(() => (props.row.isDefault ? null : props.row.id))
const existing = computed(() => props.row.models.flatMap((m) => (m.model ? [m.code] : [])))

const code = ref('')
const editing = ref<AiModelSummary | null>(null)
const editOpen = ref(false)
const fetchOpen = ref(false)

async function addCode() {
  const codes = code.value.split(/[\s,]+/).filter(Boolean)
  if (!codes.length) return
  try {
    await add.mutateAsync({ body: { workspaceId, providerId: providerId.value, codes, source: 'manual' } })
    code.value = ''
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function setInChat(model: AiModelSummary, inChat: boolean) {
  try {
    await update.mutateAsync({ path: { id: model.id }, body: { inChat } })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

function edit(model: AiModelSummary) {
  editing.value = model
  editOpen.value = true
}

async function removeModel(row: ModelRow) {
  // Removing clears every pin at it, and that work silently moves, so say so first.
  const ok = await confirm({
    title: t('ai.removeNamed', { name: row.code }),
    description: t('ai.models.removeDesc'),
    action: t('common.remove'),
    destructive: true,
  })
  if (!ok) return
  try {
    await remove.mutateAsync({ path: { id: row.id } })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <p v-if="off && !row.isDefault" class="text-muted-foreground text-xs">
    {{ t('count.modelsHidden', { n: row.models.length }, row.models.length) }}
  </p>

  <details v-else-if="row.kind !== 'none'" :open="row.models.length <= OPEN_UP_TO">
    <summary class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 w-fit cursor-pointer rounded-sm text-xs outline-none focus-visible:ring-[3px]">
      {{ row.models.length ? t('count.models', { n: row.models.length }, row.models.length) : t('ai.models.none') }}
    </summary>

    <ul v-if="row.models.length" class="mt-1 divide-y">
      <li v-for="m in row.models" :key="m.id" class="grid gap-x-3 gap-y-1 py-2 @md:grid-cols-[minmax(0,1fr)_auto] @md:items-center">
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="min-w-0 break-all font-mono text-xs">{{ m.code }}</span>
            <Badge v-if="!m.model" variant="outline" class="font-normal">{{ t('ai.default') }}</Badge>
            <Badge v-for="purpose in m.serves" :key="purpose" variant="secondary" class="font-normal">
              {{ t(`ai.purpose.${purpose}`) }}
            </Badge>
          </div>

          <p class="text-muted-foreground text-xs tabular-nums">
            <template v-if="m.price">
              {{
                t('ai.providerRow.price', {
                  prompt: formatPrice(m.price.prompt, m.price.currency),
                  completion: formatPrice(m.price.completion, m.price.currency),
                })
              }}
              <template v-if="m.price.cachedPrompt !== null">
                · {{ t('ai.providerRow.priceCached', { price: formatPrice(m.price.cachedPrompt, m.price.currency) }) }}
              </template>
              <template v-if="!m.price.custom">· {{ t('ai.providerRow.priceList') }}</template>
            </template>
            <template v-else>{{ t('ai.providerRow.priceUnknown') }}</template>
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-x-2">
          <label v-if="m.model" class="flex items-center gap-1.5 text-xs">
            <Checkbox
              :model-value="m.model.inChat"
              :disabled="!canManage"
              @update:model-value="setInChat(m.model!, $event === true)"
            />
            {{ t('ai.models.inChat') }}
          </label>

          <span v-if="canManage" class="flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              :aria-label="t('ai.providerRow.editNamed', { name: m.code })"
              @click="m.model ? edit(m.model) : $emit('editProvider')"
            >
              {{ t('common.edit') }}
            </Button>
            <Button
              v-if="m.model"
              type="button"
              variant="ghost"
              size="sm"
              :aria-label="t('ai.removeNamed', { name: m.code })"
              @click="removeModel(m)"
            >
              <Trash2 class="size-3.5" aria-hidden="true" />
            </Button>
          </span>
        </div>
      </li>
    </ul>

    <form v-if="canManage" class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="addCode">
      <Input
        v-model="code"
        class="h-8 min-w-0 flex-1 basis-48 font-mono text-xs"
        :placeholder="t('ai.models.codePlaceholder')"
        :aria-label="t('ai.models.addByCode')"
      />
      <Button type="submit" variant="outline" size="sm" :disabled="!code.trim() || add.isPending.value">{{ t('common.add') }}</Button>
      <Button type="button" variant="ghost" size="sm" @click="fetchOpen = true">{{ t('ai.models.fetch') }}</Button>
    </form>

    <AiModelDialog v-model:open="editOpen" :model="editing" />
    <AiModelFetchDialog v-model:open="fetchOpen" :provider-id="providerId" :title="title" :existing="existing" />
  </details>
</template>
