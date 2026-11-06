<script setup lang="ts">
/**
 * Add or edit one provider: a new profile, an existing one, or the default.
 *
 * One form because they are one thing to the reader, with the default's two
 * differences kept honest. It has no name and no off switch (its off is provider
 * `none`), and every field is an override of the environment: empty means "keep
 * inheriting", and the placeholder shows what is inherited. The provider select
 * cannot be empty, so an untouched one is sent as null for the same reason.
 *
 * It saves on its own rather than through the page's Save bar, as profiles always
 * have, so a provider is one act wherever it sits in the list.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { effectiveModelPrice, PROVIDER_DEFAULTS } from '@knowledge/contracts'
import type { AiProvider, AiProviderKind, AiSettingsResponse } from '@knowledge/contracts'
import { useApiMutation } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { confirm } from '@/shared/ui/confirm'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { formatPrice } from '@/shared/utils/format'
import { parsePrice, type ProviderDialogTarget } from '@/modules/assistant/model/provider-rows'

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
  enabled: true,
  pricePrompt: '',
  priceCompletion: '',
}
const form = ref({ ...EMPTY_FORM })

const priceText = (n: number | null | undefined) => (n == null ? '' : String(n))

function reset() {
  const s = props.settings
  const p = profile.value
  if (p) {
    form.value = {
      ...EMPTY_FORM,
      name: p.name,
      provider: p.provider,
      baseUrl: p.baseUrl ?? '',
      model: p.model,
      enabled: p.enabled,
      pricePrompt: priceText(p.pricePromptPerMTok),
      priceCompletion: priceText(p.priceCompletionPerMTok),
    }
  } else if (isDefault.value) {
    form.value = {
      ...EMPTY_FORM,
      provider: s.provider,
      baseUrl: s.sources.baseUrl === 'db' ? s.baseUrl : '',
      model: s.sources.model === 'db' ? s.model : '',
      pricePrompt: priceText(s.pricePromptPerMTok),
      priceCompletion: priceText(s.priceCompletionPerMTok),
    }
  } else {
    form.value = { ...EMPTY_FORM }
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

/** The model the price below applies to: what the field will resolve to. */
const pricedModel = computed(() => form.value.model.trim() || inheritedModel.value || '')
const listPrice = computed(() => effectiveModelPrice(pricedModel.value, null, null))

const prompt = computed(() => parsePrice(form.value.pricePrompt))
const completion = computed(() => parsePrice(form.value.priceCompletion))
const pricesValid = computed(() => prompt.value !== undefined && completion.value !== undefined)
const willBePriced = computed(
  () => !pricesValid.value || effectiveModelPrice(pricedModel.value, prompt.value ?? null, completion.value ?? null) !== null,
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
      s.priceCompletionPerMTok !== null)
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
  if (!pricesValid.value) return
  const f = form.value
  const prices = { pricePromptPerMTok: prompt.value ?? null, priceCompletionPerMTok: completion.value ?? null }
  try {
    if (isDefault.value) {
      const s = props.settings
      await saveSettings.mutateAsync({
        body: {
          workspaceId,
          provider: f.provider === s.provider && s.sources.provider === 'env' ? null : f.provider,
          baseUrl: off.value ? null : f.baseUrl.trim() || null,
          model: off.value ? null : f.model.trim() || null,
          ...prices,
          ...keyField.value,
        },
      })
      toast.success(t('ai.settingsSaved'))
    } else {
      // A model is required on a profile; an empty box means the kind's default.
      const fields = {
        name: f.name.trim(),
        provider: f.provider as AiProviderKind,
        baseUrl: f.baseUrl.trim() || null,
        model: f.model.trim() || inheritedModel.value || '',
        enabled: f.enabled,
        ...prices,
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
      body: { workspaceId, provider: null, baseUrl: null, model: null, apiKey: null, pricePromptPerMTok: null, priceCompletionPerMTok: null },
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
          <label class="block space-y-1.5" :class="off && 'sm:col-span-2'">
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
          <label v-if="!off" class="block space-y-1.5">
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

          <fieldset class="space-y-2">
            <legend class="text-muted-foreground mb-1.5 text-xs font-medium">{{ t('ai.providerDialog.price') }}</legend>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block space-y-1">
                <span class="text-xs">{{ t('ai.prompt') }}</span>
                <Input
                  v-model="form.pricePrompt"
                  inputmode="decimal"
                  :placeholder="listPrice ? String(listPrice.prompt) : undefined"
                  :aria-invalid="prompt === undefined || undefined"
                />
              </label>
              <label class="block space-y-1">
                <span class="text-xs">{{ t('ai.completion') }}</span>
                <Input
                  v-model="form.priceCompletion"
                  inputmode="decimal"
                  :placeholder="listPrice ? String(listPrice.completion) : undefined"
                  :aria-invalid="completion === undefined || undefined"
                />
              </label>
            </div>
            <p v-if="!pricesValid" class="text-destructive text-xs">{{ t('ai.providerDialog.priceInvalid') }}</p>
            <p v-else-if="!willBePriced" class="text-muted-foreground text-xs">
              {{ t('ai.providerDialog.priceMissing') }}
            </p>
            <p v-else-if="listPrice" class="text-muted-foreground text-xs tabular-nums">
              {{
                t('ai.providerDialog.priceListed', {
                  model: pricedModel,
                  prompt: formatPrice(listPrice.prompt),
                  completion: formatPrice(listPrice.completion),
                })
              }}
            </p>
            <p v-if="form.provider === 'gen-api'" class="text-muted-foreground text-xs">{{ t('ai.providerDialog.priceGenApi') }}</p>
          </fieldset>
        </template>
        <p v-else class="text-muted-foreground text-xs">{{ t('ai.providerRow.noneHint') }}</p>

        <label v-if="!isDefault" class="flex items-center gap-2">
          <Checkbox :model-value="form.enabled" @update:model-value="form.enabled = $event === true" />
          <span class="text-sm">{{ t('ai.enabled') }}</span>
        </label>
      </form>

      <DialogFooter class="sm:justify-between">
        <Button v-if="hasOverrides" type="button" variant="ghost" size="sm" :disabled="saving" @click="useEnvironment">
          {{ t('ai.providerDialog.reset') }}
        </Button>
        <span v-else class="hidden sm:block" aria-hidden="true" />
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" size="sm" @click="open = false">{{ t('common.cancel') }}</Button>
          <Button type="submit" form="provider-form" size="sm" :disabled="saving || !pricesValid">
            {{ target.kind === 'new' ? t('common.add') : t('common.save') }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
