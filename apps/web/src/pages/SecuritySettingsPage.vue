<script setup lang="ts">
/**
 * /settings/security (#75): a workspace's sign-in settings and its audit
 * trail. Admin-only, like the routes behind it. Phase 1 ships the audit log;
 * the identity providers, domains, group mapping, SCIM and policy sections
 * join it with the phases that build them.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import AuditLogTable from '@/components/security/AuditLogTable.vue'

const { t } = useI18n()
const auth = useAuthStore()
const canManage = computed(() => auth.canAdminWorkspace)
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-6">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('security.title') }}</h1>
      <p class="mt-0.5 text-sm text-muted-foreground">{{ t('security.subtitle') }}</p>
    </div>
    <p v-if="!canManage" class="text-sm text-muted-foreground">{{ t('security.adminOnly') }}</p>
    <AuditLogTable v-else />
  </div>
</template>
