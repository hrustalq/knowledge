<script setup lang="ts">
/**
 * /settings/security (#75): a workspace's sign-in settings and its audit
 * trail. Admin-only, like the routes behind it. Providers first, the audit log
 * last; domains, group mapping, provisioning (SCIM) and policy between them.
 *
 * The shared PageTabs strip, as on /settings/connectors: `?tab=` picks the
 * tab a link opens on.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/widgets/page'
import AuditLogTable from '@/modules/access/components/AuditLogTable.vue'
import AuthPolicyPanel from '@/modules/access/components/AuthPolicyPanel.vue'
import GroupMappingsPanel from '@/modules/access/components/GroupMappingsPanel.vue'
import IdentityProvidersPanel from '@/modules/access/components/IdentityProvidersPanel.vue'
import ScimPanel from '@/modules/access/components/ScimPanel.vue'
import SsoDomainsPanel from '@/modules/access/components/SsoDomainsPanel.vue'

const { t } = useI18n()
const auth = useAuthStore()
const canManage = computed(() => auth.canAdminWorkspace)

const TAB_KEYS = ['providers', 'domains', 'groups', 'provisioning', 'policy', 'audit'] as const
type TabKey = (typeof TAB_KEYS)[number]

const tabs = computed<PageTab<TabKey>[]>(() => TAB_KEYS.map((key) => ({ key, label: t(`security.tabs.${key}`) })))
const tab = usePageTabs(tabs, 'providers')
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('security.title') }}</h1>
      <p class="mt-0.5 text-sm text-muted-foreground">{{ t('security.subtitle') }}</p>
    </div>
    <p v-if="!canManage" class="text-sm text-muted-foreground">{{ t('security.adminOnly') }}</p>
    <template v-else>
      <PageTabs v-model="tab" :tabs="tabs" :label="t('security.title')" />
      <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)" class="min-w-0">
        <IdentityProvidersPanel v-if="tab === 'providers'" />
        <SsoDomainsPanel v-else-if="tab === 'domains'" />
        <GroupMappingsPanel v-else-if="tab === 'groups'" />
        <ScimPanel v-else-if="tab === 'provisioning'" />
        <AuthPolicyPanel v-else-if="tab === 'policy'" />
        <AuditLogTable v-else />
      </div>
    </template>
  </div>
</template>
