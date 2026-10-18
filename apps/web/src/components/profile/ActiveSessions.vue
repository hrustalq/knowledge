<script setup lang="ts">
/**
 * Where you are signed in (#75): every live session, with how it was opened,
 * from where, and when it was last used. Any but the current one can be signed
 * out from here — a browser you left logged in elsewhere. The current one is
 * not, because that is what Log out is for, and a row that signs you out of the
 * page you are reading would look like a crash.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Monitor } from 'lucide-vue-next'
import type { ListSessionsResponse, SessionView } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { formatRelative } from '@/lib/format'
import { labelFor } from '@/lib/labels'
import { describeUserAgent } from '@/lib/user-agent'
import { Button } from '@/components/ui/button'

const { t } = useI18n()
const queryClient = useQueryClient()
const options = apiQueryOptions('/v1/me/sessions')
const query = useQuery(options)
const sessions = computed(() => (query.data.value as ListSessionsResponse | undefined)?.sessions ?? [])

function device(s: SessionView): string {
  const d = describeUserAgent(s.userAgent)
  if (!d) return t('profileSettings.sessions.unknownDevice')
  return d.os ? t('profileSettings.sessions.onDevice', { browser: d.browser, os: d.os }) : d.browser
}

async function revoke(id: string) {
  try {
    await api.delete('/v1/me/sessions/{sessionId}', { path: { sessionId: id } })
    toast.success(t('profileSettings.sessions.revoked'))
    void queryClient.invalidateQueries({ queryKey: options.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t) || t('profileSettings.sessions.failed'))
  }
}
</script>

<template>
  <div class="min-w-0">
    <h3 class="text-sm font-medium">{{ t('profileSettings.sessions.title') }}</h3>
    <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.sessions.hint') }}</p>
  </div>
  <ul v-if="sessions.length" class="mt-3 space-y-3">
    <li v-for="s in sessions" :key="s.id" class="flex items-start gap-2.5 text-sm">
      <Monitor class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="truncate">
          {{ device(s) }}
          <span v-if="s.current" class="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
            {{ t('profileSettings.sessions.current') }}
          </span>
        </p>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {{ labelFor(t, 'profileSettings.sessions.method', s.authMethod) }}
          <template v-if="s.ip"> · <span class="font-mono">{{ s.ip }}</span></template>
          · {{ s.lastSeenAt
            ? t('profileSettings.sessions.lastSeen', { when: formatRelative(s.lastSeenAt) })
            : t('profileSettings.sessions.signedIn', { when: formatRelative(s.createdAt) }) }}
        </p>
      </div>
      <Button v-if="!s.current" variant="outline" size="sm" class="shrink-0" @click="revoke(s.id)">
        {{ t('profileSettings.sessions.revoke') }}
      </Button>
    </li>
  </ul>
  <p v-else-if="query.isSuccess.value" class="mt-3 text-xs text-muted-foreground">{{ t('profileSettings.sessions.none') }}</p>
</template>
