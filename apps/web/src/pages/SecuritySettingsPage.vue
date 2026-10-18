<script setup lang="ts">
/**
 * /settings/security (#75): a workspace's sign-in settings and its audit
 * trail. Admin-only, like the routes behind it. Providers first, the audit log
 * last; domains, group mapping, provisioning (SCIM) and policy between them.
 *
 * Hand-rolled tab strip, as on /settings/connectors: `?tab=` is an opening
 * instruction, not two-way state.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AuditLogTable from '@/components/security/AuditLogTable.vue'
import AuthPolicyPanel from '@/components/security/AuthPolicyPanel.vue'
import GroupMappingsPanel from '@/components/security/GroupMappingsPanel.vue'
import IdentityProvidersPanel from '@/components/security/IdentityProvidersPanel.vue'
import ScimPanel from '@/components/security/ScimPanel.vue'
import SsoDomainsPanel from '@/components/security/SsoDomainsPanel.vue'

const { t } = useI18n()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const canManage = computed(() => auth.canAdminWorkspace)

// `label` is a message key — resolved with t() where the tab renders.
const TABS = [
  { key: 'providers', label: 'security.tabs.providers' },
  { key: 'domains', label: 'security.tabs.domains' },
  { key: 'groups', label: 'security.tabs.groups' },
  { key: 'provisioning', label: 'security.tabs.provisioning' },
  { key: 'policy', label: 'security.tabs.policy' },
  { key: 'audit', label: 'security.tabs.audit' },
] as const
type TabKey = (typeof TABS)[number]['key']

const tab = computed<TabKey>(() => {
  const q = route.query.tab
  return TABS.some((entry) => entry.key === q) ? (q as TabKey) : 'providers'
})

function setTab(key: TabKey) {
  void router.replace({ query: { ...route.query, tab: key } })
}
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('security.title') }}</h1>
      <p class="mt-0.5 text-sm text-muted-foreground">{{ t('security.subtitle') }}</p>
    </div>
    <p v-if="!canManage" class="text-sm text-muted-foreground">{{ t('security.adminOnly') }}</p>
    <template v-else>
      <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
        <button
          v-for="tabDef in TABS"
          :key="tabDef.key"
          role="tab"
          :aria-selected="tab === tabDef.key"
          class="focus-visible:ring-ring rounded-t-sm border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none"
          :class="
            tab === tabDef.key
              ? 'border-primary text-primary font-medium'
              : 'text-muted-foreground hover:text-foreground hover:border-border border-transparent'
          "
          @click="setTab(tabDef.key)"
        >
          {{ t(tabDef.label) }}
        </button>
      </div>
      <IdentityProvidersPanel v-if="tab === 'providers'" />
      <SsoDomainsPanel v-else-if="tab === 'domains'" />
      <GroupMappingsPanel v-else-if="tab === 'groups'" />
      <ScimPanel v-else-if="tab === 'provisioning'" />
      <AuthPolicyPanel v-else-if="tab === 'policy'" />
      <AuditLogTable v-else />
    </template>
  </div>
</template>
