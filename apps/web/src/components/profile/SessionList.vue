<script setup lang="ts">
/**
 * Rows of login sessions (#75, #292): how each was opened, from where, and when
 * it was last used. Shared by your own profile and a platform admin's view of
 * someone else's, so both read a session the same way; the caller owns the
 * fetching and decides what revoking means. The current session gets no button
 * — signing out the page you are reading is what Log out is for.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Monitor } from 'lucide-vue-next'
import type { SessionView } from '@knowledge/contracts'
import { formatRelative } from '@/lib/format'
import { labelFor } from '@/lib/labels'
import { describeUserAgent } from '@/lib/user-agent'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  sessions: SessionView[]
  revoke: (id: string) => Promise<void>
}>()

const { t } = useI18n()
const pending = ref<string | null>(null)

function device(s: SessionView): string {
  const d = describeUserAgent(s.userAgent)
  if (!d) return t('profileSettings.sessions.unknownDevice')
  return d.os ? t('profileSettings.sessions.onDevice', { browser: d.browser, os: d.os }) : d.browser
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
          <span v-if="s.current" class="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
            {{ t('profileSettings.sessions.current') }}
          </span>
        </p>
        <p class="mt-0.5 break-words text-xs text-muted-foreground">
          {{ labelFor(t, 'profileSettings.sessions.method', s.authMethod) }}
          <template v-if="s.providerName"> · {{ s.providerName }}</template>
          <template v-if="s.ip"> · <span class="font-mono">{{ s.ip }}</span></template>
          · {{ s.lastSeenAt
            ? t('profileSettings.sessions.lastSeen', { when: formatRelative(s.lastSeenAt) })
            : t('profileSettings.sessions.signedIn', { when: formatRelative(s.createdAt) }) }}
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
        {{ t('profileSettings.sessions.revoke') }}
      </Button>
    </li>
  </ul>
</template>
