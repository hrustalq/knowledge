<script setup lang="ts">
/**
 * Add or edit one provider's connection: a new one, an existing one, or the default.
 * What it serves is its model list, on the row.
 *
 * One form because they are one thing to the reader, with the default's differences
 * kept honest. It has no name and no off switch (its off is provider `none`), it
 * carries its own implicit model and that model's price, and every field is an
 * override of the environment: empty means "keep inheriting", and the placeholder
 * shows what is inherited. The provider select cannot be empty, so an untouched one
 * is sent as null for the same reason.
 *
 * It saves on its own rather than through the page's Save bar, as profiles always
 * have, so a provider is one act wherever it sits in the list.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { PROVIDER_DEFAULTS } from '@knowledge/contracts'
import type { AiProvider, AiProviderKind, AiSettingsResponse } from '@knowledge/contracts'
import { useApiMutation } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { Button } from '@/shared/ui/button'
import { confirm } from '@/shared/ui/confirm'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import type { ProviderDialogTarget } from '@/modules/assistant/model/provider-rows'
import { usePriceFields } from '@/modules/assistant/model/use-price-fields'
import AiPriceFields from './AiPriceFields.vue'

const props = defineProps<{ target: ProviderDialogTarget; settings: AiSettingsResponse }>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const workspaceId = getWorkspaceId()

const invalidates = () => [['/v1/ai/providers'], ['/v1/ai/settings'], ['/v1/ai/providers/choices']]
const createProvider = useApiMutation('post', '/v1/ai/providers', { invalidates })
const updateProvider = useApiMutation('patch', '/v1/ai/providers/{id}', { invalidates })
const saveSettings = useApiMutation('patch', '/v1/ai/settings', { invalidates })
const saving = computed(() => createProvider.isPending.value || updateProvider.isPending.value || saveSettings.isPending.value)

const isDefault = computed(() => props.target.kind === 'default')
const profile = computed(() => (props.target.kind === 'profile' ? props.target.provider : null))

const EMPTY_FORM = {
  name: '',
  provider: 'deepseek' as AiProvider,
  baseUrl: '',
  model: '',
  apiKey: '',
  clearKey: false,
}
const form = ref({ ...EMPTY_FORM })

function reset() {
  const s = props.settings
  const p = profile.value
  if (p) {
    form.value = { ...EMPTY_FORM, name: p.name, provider: p.provider, baseUrl: p.baseUrl ?? '' }
    price.load()
  } else if (isDefault.value) {
    form.value = {
      ...EMPTY_FORM,
      provider: s.provider,
      baseUrl: s.sources.baseUrl === 'db' ? s.baseUrl : '',
      model: s.sources.model === 'db' ? s.model : '',
    }
    price.load(s)
  } else {
    form.value = { ...EMPTY_FORM }
    price.load()
  }
}

watch(open, (isOpen) => {
  if (isOpen) reset()
})

const off = computed(() => form.value.provider === 'none')
const kindDefaults = computed(() => PROVIDER_DEFAULTS[form.value.provider])

/**
 * What an empty field resolves to. Only the default inherits the environment,
 * and only while its provider is the inherited one: `AiConfigService.resolve`
 * drops the env model and URL once a workspace names a provider of its own.
 */
function inherited(field: 'baseUrl' | 'model'): string | undefined {
  const s = props.settings
  const fromEnv = isDefault.value && s.sources.provider === 'env' && form.value.provider === s.provider
  if (fromEnv && s.sources[field] === 'env' && s[field]) return s[field]
  return kindDefaults.value?.[field]
}
const inheritedBaseUrl = computed(() => inherited('baseUrl'))
const inheritedModel = computed(() => inherited('model'))

/** The default's own model: what its price below applies to. */
const price = usePriceFields(
  () => form.value.model.trim() || inheritedModel.value || '',
  () => form.value.provider,
)

/** Anything stored for the default that the reset below would hand back to the environment. */
const hasOverrides = computed(() => {
  const s = props.settings
  return (
    isDefault.value &&
    (s.sources.provider === 'db' ||
      s.sources.baseUrl === 'db' ||
      s.sources.model === 'db' ||
      s.sources.apiKey === 'db' ||
      s.pricePromptPerMTok !== null ||
      s.priceCompletionPerMTok !== null ||
      s.priceCachedPerMTok !== null)
  )
})

const storedKeyHint = computed(() => {
  if (isDefault.value) return props.settings.sources.apiKey === 'db' ? props.settings.apiKeyHint : null
  return profile.value?.apiKeyHint ?? null
})

const keyPlaceholder = computed(() => {
  if (form.value.clearKey) return isDefault.value ? t('ai.providerDialog.keyClearedEnv') : t('ai.providerDialog.keyClearedDefault')
  if (!props.settings.canStoreSecrets) return t('ai.noEncryptionKey')
  if (storedKeyHint.value) return storedKeyHint.value
  if (isDefault.value) return props.settings.hasApiKey ? t('ai.setInEnvironment') : t('ai.notConfigured')
  return t('ai.providerDialog.keyOptional')
})

const keyField = computed(() => (form.value.clearKey ? { apiKey: null } : form.value.apiKey ? { apiKey: form.value.apiKey } : {}))

async function submit() {
  if (isDefault.value && !price.valid.value) return
  const f = form.value
  try {
    if (isDefault.value) {
      const s = props.settings
      await saveSettings.mutateAsync({
        body: {
          workspaceId,
          provider: f.provider === s.provider && s.sources.provider === 'env' ? null : f.provider,
          baseUrl: off.value ? null : f.baseUrl.trim() || null,
          model: off.value ? null : f.model.trim() || null,
          ...price.prices.value,
          ...keyField.value,
        },
      })
      toast.success(t('ai.settingsSaved'))
    } else {
      const fields = {
        name: f.name.trim(),
        provider: f.provider as AiProviderKind,
        baseUrl: f.baseUrl.trim() || null,
        ...keyField.value,
      }
      if (profile.value) {
        await updateProvider.mutateAsync({ path: { id: profile.value.id }, body: fields })
        toast.success(t('ai.providerUpdated'))
      } else {
        await createProvider.mutateAsync({ body: { workspaceId, ...fields } })
        toast.success(t('ai.providerAdded'))
      }
    }
    open.value = false
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function useEnvironment() {
  const ok = await confirm({
    title: t('ai.providerDialog.resetTitle'),
    description: t('ai.providerDialog.resetDesc'),
    action: t('ai.providerDialog.reset'),
    destructive: true,
  })
  if (!ok) return
  try {
    await saveSettings.mutateAsync({
      body: { workspaceId, provider: null, baseUrl: null, model: null, apiKey: null, pricePromptPerMTok: null, priceCompletionPerMTok: null, priceCachedPerMTok: null, priceCurrency: null },
    })
    toast.success(t('ai.settingsSaved'))
    open.value = false
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {{ isDefault ? t('ai.providerDialog.defaultTitle') : profile ? t('ai.editProvider') : t('ai.addProvider') }}
        </DialogTitle>
        <DialogDescription>
          {{ isDefault ? t('ai.providerDialog.defaultDesc') : t('ai.providerDialogDesc') }}
        </DialogDescription>
      </DialogHeader>

      <form id="provider-form" class="space-y-4" @submit.prevent="submit">
        <label v-if="!isDefault" class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('ai.name') }}</span>
          <Input v-model="form.name" required placeholder="DeepSeek prod" />
        </label>

        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block space-y-1.5" :class="(off || !isDefault) && 'sm:col-span-2'">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.provider') }}</span>
            <Select v-model="form.provider">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-if="isDefault" value="none">{{ t('ai.providerNone') }}</SelectItem>
                <SelectItem value="deepseek">DeepSeek</SelectItem>
                <SelectItem value="gen-api">GenAPI (gen-api.ru)</SelectItem>
                <SelectItem value="openai-compatible">{{ t('ai.openaiCompatible') }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label v-if="isDefault && !off" class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.model') }}</span>
            <Input v-model="form.model" :required="!inheritedModel" :placeholder="inheritedModel ?? t('ai.providerDialog.modelId')" />
          </label>
        </div>

        <template v-if="!off">
          <label class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.baseUrl') }}</span>
            <Input v-model="form.baseUrl" :required="!inheritedBaseUrl" :placeholder="inheritedBaseUrl ?? 'https://host/v1'" />
          </label>

          <div class="space-y-1.5">
            <label for="provider-key" class="text-muted-foreground block text-xs font-medium">{{ t('ai.apiKey') }}</label>
            <div class="flex items-center gap-2">
              <Input
                id="provider-key"
                v-model="form.apiKey"
                type="password"
                autocomplete="off"
                :disabled="form.clearKey || !settings.canStoreSecrets"
                :placeholder="keyPlaceholder"
              />
              <Button
                v-if="storedKeyHint"
                type="button"
                variant="outline"
                size="sm"
                class="shrink-0"
                @click="
                  form.clearKey = !form.clearKey;
                  form.apiKey = ''
                "
              >
                {{ form.clearKey ? t('ai.keep') : t('common.clear') }}
              </Button>
            </div>
            <p v-if="!settings.canStoreSecrets" class="text-muted-foreground text-xs">{{ t('ai.noSecretKey') }}</p>
            <p v-else-if="storedKeyHint && !form.clearKey" class="text-muted-foreground text-xs">{{ t('ai.leaveEmptyToKeep') }}</p>
          </div>

          <AiPriceFields v-if="isDefault" :price="price" />
        </template>
        <p v-else class="text-muted-foreground text-xs">{{ t('ai.providerRow.noneHint') }}</p>
      </form>

      <DialogFooter class="sm:justify-between">
        <Button v-if="hasOverrides" type="button" variant="ghost" size="sm" :disabled="saving" @click="useEnvironment">
          {{ t('ai.providerDialog.reset') }}
        </Button>
        <span v-else class="hidden sm:block" aria-hidden="true" />
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" size="sm" @click="open = false">{{ t('common.cancel') }}</Button>
          <Button type="submit" form="provider-form" size="sm" :disabled="saving || (isDefault && !price.valid.value)">
            {{ target.kind === 'new' ? t('common.add') : t('common.save') }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
