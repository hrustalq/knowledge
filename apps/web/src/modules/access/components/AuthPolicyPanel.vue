<script setup lang="ts">
/**
 * Settings → Security → Policy (#75 phase 4): enforced SSO for the workspace,
 * API keys under it, the admin password exception, a session age cap.
 *
 * Each setting shows what was asked and, when the instance clamps it, what
 * applies — a silent clamp lies about the configuration. The form is the
 * whole policy (the API replaces it), edited locally and saved at once, so
 * the lock-out check runs against the policy as it will be.
 */
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { WorkspaceAuthPolicyView } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { ApiRequestError } from '@/shared/api/http'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { formatList } from '@/shared/utils/format'
import { Button } from '@/shared/ui/button'
import { confirm } from '@/shared/ui/confirm'
import { Checkbox } from '@/shared/ui/checkbox'
import { Input } from '@/shared/ui/input'
import { PageState } from '@/shared/layout'

const { t } = useI18n()
const workspaceId = getWorkspaceId()
const path = { id: workspaceId }

const query = useQuery({ ...apiQueryOptions('/v1/workspaces/{id}/auth-policy', { path }), retry: false })
const view = computed(() => query.data.value as WorkspaceAuthPolicyView | undefined)
const save = useApiMutation('put', '/v1/workspaces/{id}/auth-policy', { invalidates: () => [['/v1/workspaces/{id}/auth-policy']] })

// The number input may hand back a number or a string; `hours` reads either.
const form = reactive({ ssoEnforced: false, allowApiKeys: true, allowPasswordForAdmins: false, sessionMaxAgeHours: '' as string | number })

// Re-seed from the server whenever it answers — after a save, too.
watch(
  view,
  (v) => {
    if (!v) return
    form.ssoEnforced = v.asked.ssoEnforced === true
    form.allowApiKeys = v.asked.allowApiKeys !== false
    form.allowPasswordForAdmins = v.asked.allowPasswordForAdmins === true
    form.sessionMaxAgeHours = v.asked.sessionMaxAgeHours ? String(v.asked.sessionMaxAgeHours) : ''
  },
  { immediate: true },
)

const hours = computed(() => {
  const raw = String(form.sessionMaxAgeHours ?? '').trim()
  const n = Number(raw)
  return raw && Number.isInteger(n) && n >= 1 ? n : null
})
const ageClamped = computed(() => !!view.value && hours.value !== null && hours.value >= view.value.ceilings.sessionTtlHours)
const dirty = computed(() => {
  const v = view.value
  if (!v) return false
  return (
    form.ssoEnforced !== (v.asked.ssoEnforced === true) ||
    form.allowApiKeys !== (v.asked.allowApiKeys !== false) ||
    form.allowPasswordForAdmins !== (v.asked.allowPasswordForAdmins === true) ||
    hours.value !== (v.asked.sessionMaxAgeHours ?? null)
  )
})

async function submit() {
  if (form.ssoEnforced && !view.value?.asked.ssoEnforced) {
    const ok = await confirm({
      title: t('security.policy.enforceTitle'),
      description: t('security.policy.enforceBody'),
      action: t('security.domains.enforce'),
    })
    if (!ok) return
  }
  try {
    await save.mutateAsync({
      path,
      body: {
        // Defaults go back as null, so the row stays sparse and follows a changed default.
        ssoEnforced: form.ssoEnforced || null,
        allowApiKeys: form.allowApiKeys ? null : false,
        allowPasswordForAdmins: form.allowPasswordForAdmins || null,
        sessionMaxAgeHours: hours.value,
      },
    })
    toast.success(t('security.policy.saved'))
  } catch (e) {
    const failure = e instanceof ApiRequestError ? e.details?.failure : undefined
    toast.error(typeof failure === 'string' ? t(`security.policy.lockout.${failure}`) : errorMessage(e, t))
  }
}
</script>

<template>
  <section class="flex flex-col gap-4">
    <div>
      <h2 class="text-base font-semibold">{{ t('security.policy.title') }}</h2>
      <p class="mt-0.5 max-w-prose text-sm text-muted-foreground">{{ t('security.policy.hint') }}</p>
    </div>

    <PageState v-if="query.isPending.value" state="loading" :rows="3" row-class="h-12" />
    <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />

    <form v-else-if="view" class="flex flex-col gap-5 rounded-md border p-4" @submit.prevent="submit">
      <p v-if="!view.ceilings.ssoEnabled" class="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        {{ t('security.policy.ssoOff') }}
      </p>

      <fieldset class="grid gap-3" :disabled="!view.ceilings.ssoEnabled">
        <label class="flex items-start gap-2 text-sm">
          <Checkbox class="mt-0.5" :model-value="form.ssoEnforced" @update:model-value="form.ssoEnforced = !!$event" />
          <span>
            <span class="font-medium">{{ t('security.policy.ssoEnforced') }}</span>
            <span class="block text-muted-foreground">
              {{
                view.providers.length
                  ? t('security.policy.ssoEnforcedHint', { providers: formatList(view.providers.map((p) => p.name)) })
                  : t('security.policy.noProviders')
              }}
            </span>
            <span v-if="view.asked.ssoEnforced && !view.applied.ssoEnforced" class="block text-panel-warning-ink">
              {{ t('security.policy.notApplied') }}
            </span>
          </span>
        </label>

        <div class="grid gap-3 border-l pl-4" :class="!form.ssoEnforced && 'opacity-60'">
          <label class="flex items-start gap-2 text-sm">
            <Checkbox class="mt-0.5" :model-value="form.allowApiKeys" :disabled="!form.ssoEnforced" @update:model-value="form.allowApiKeys = !!$event" />
            <span>
              <span class="font-medium">{{ t('security.policy.allowApiKeys') }}</span>
              <span class="block text-muted-foreground">{{ t('security.policy.allowApiKeysHint') }}</span>
            </span>
          </label>
        </div>

        <label class="flex items-start gap-2 text-sm">
          <Checkbox class="mt-0.5" :model-value="form.allowPasswordForAdmins" @update:model-value="form.allowPasswordForAdmins = !!$event" />
          <span>
            <span class="font-medium">{{ t('security.policy.allowPasswordForAdmins') }}</span>
            <span class="block text-muted-foreground">{{ t('security.policy.allowPasswordForAdminsHint') }}</span>
          </span>
        </label>
      </fieldset>

      <div class="grid gap-1">
        <label class="text-sm font-medium" for="ap-age">{{ t('security.policy.sessionMaxAge') }}</label>
        <Input
          id="ap-age"
          v-model="form.sessionMaxAgeHours"
          class="w-40"
          inputmode="numeric"
          type="number"
          min="1"
          max="8760"
          :placeholder="t('security.policy.sessionMaxAgeNone')"
        />
        <p class="text-xs text-muted-foreground">
          {{ t('security.policy.sessionMaxAgeHint', { ttl: view.ceilings.sessionTtlHours }) }}
        </p>
        <p v-if="ageClamped" class="text-xs text-panel-warning-ink">
          {{ t('security.policy.sessionMaxAgeClamped', { ttl: view.ceilings.sessionTtlHours }) }}
        </p>
      </div>

      <p class="text-xs text-muted-foreground">{{ t('security.policy.breakGlass') }}</p>

      <div>
        <Button type="submit" :disabled="save.isPending.value || !dirty">{{ t('security.policy.save') }}</Button>
      </div>
    </form>
  </section>
</template>
