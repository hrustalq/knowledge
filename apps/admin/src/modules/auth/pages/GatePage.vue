<script setup lang="ts">
// What anyone the console refuses sees (#1236): a signed-in non-admin, or a
// failed identity check. No admin route has been called by the time this draws.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, RotateCw } from 'lucide-vue-next'
import { Button } from '@knowledge/ui/button'
import { PageState } from '@knowledge/ui/layout'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const auth = useAuthStore()
const failed = computed(() => auth.error !== null)
const error = computed(() => auth.error ?? undefined)

function retry() {
  window.location.assign('/admin/')
}
</script>

<template>
  <div class="grid min-h-dvh place-items-center px-4 py-10">
    <PageState
      class="w-full max-w-lg"
      :state="failed ? 'error' : 'forbidden'"
      :title="t(failed ? 'admin.gate.errorTitle' : 'admin.gate.forbiddenTitle')"
      :description="failed ? undefined : t('admin.gate.forbiddenDescription')"
      :error="error"
    >
      <template #actions>
        <div class="flex flex-wrap justify-center gap-2">
          <Button v-if="failed" variant="outline" @click="retry">
            <RotateCw class="size-4" aria-hidden="true" />
            {{ t('admin.gate.retry') }}
          </Button>
          <Button as="a" href="/" variant="ghost">
            <ArrowLeft class="size-4" aria-hidden="true" />
            {{ t('admin.backToApp') }}
          </Button>
        </div>
      </template>
    </PageState>
  </div>
</template>
