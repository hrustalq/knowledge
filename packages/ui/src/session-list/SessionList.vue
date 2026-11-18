<script setup lang="ts">
/**
 * Rows of login sessions (#75, #292): how each was opened, from where, and when
 * it was last used. Shared by your own profile, a workspace's member view and
 * the admin console's user page (#1239), so every surface reads a session the
 * same way; the caller owns the fetching and decides what revoking means. The
 * current session gets no button: signing out the page you are reading is what
 * Log out is for.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Monitor } from 'lucide-vue-next'
import { Button } from '../button'
import type { SessionRow } from './types'
import { describeUserAgent } from './user-agent'

const props = defineProps<{
  sessions: SessionRow[]
  revoke: (id: string) => Promise<void>
  /** "5 minutes ago" for an ISO time, in the app's locale: the kit formats no dates itself. */
  when: (iso: string) => string
}>()

const { t } = useI18n()
const pending = ref<string | null>(null)

const METHOD: Record<string, string> = {
  password: 'ui.sessions.method.password',
  oidc: 'ui.sessions.method.oidc',
  saml: 'ui.sessions.method.saml',
  ldap: 'ui.sessions.method.ldap',
}

function device(s: SessionRow): string {
  const d = describeUserAgent(s.userAgent)
  if (!d) return t('ui.sessions.unknownDevice')
  return d.os ? t('ui.sessions.onDevice', { browser: d.browser, os: d.os }) : d.browser
}

async function onRevoke(id: string) {
  pending.value = id
  try {
    await props.revoke(id)
  } finally {
    pending.value = null
  }
}
</script>

<template>
  <ul class="space-y-3">
    <li v-for="s in sessions" :key="s.id" class="flex items-start gap-2.5 text-sm">
      <Monitor class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="truncate">
          {{ device(s) }}
          <span v-if="s.current" class="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-caption font-medium text-primary">
            {{ t('ui.sessions.current') }}
          </span>
        </p>
        <p class="mt-0.5 break-words text-xs text-muted-foreground">
          {{ t(METHOD[s.authMethod] ?? METHOD.password) }}
          <template v-if="s.providerName"> · {{ s.providerName }}</template>
          <template v-if="s.ip"> · <span class="font-mono">{{ s.ip }}</span></template>
          · {{ s.lastSeenAt
            ? t('ui.sessions.lastSeen', { when: when(s.lastSeenAt) })
            : t('ui.sessions.signedIn', { when: when(s.createdAt) }) }}
        </p>
      </div>
      <Button
        v-if="!s.current"
        variant="outline"
        size="sm"
        class="shrink-0"
        :disabled="pending === s.id"
        @click="onRevoke(s.id)"
      >
        {{ t('ui.sessions.revoke') }}
      </Button>
    </li>
  </ul>
</template>
