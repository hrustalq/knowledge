<script setup lang="ts">
/**
 * How a Figma connector authenticates, and the way to change it (#557,
 * docs/features/64): the Figma person its OAuth grant acts as, with Reconnect
 * and Disconnect, or a Connect button for one still on a pasted token.
 *
 * Shown only where Connect with Figma is offered (or the connector already
 * uses it), so a deployment without the OAuth app sees the page it always did.
 * Connecting opens a new tab and rereads the connector once the connections
 * long poll sees the grant land, or this tab regains focus.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { CircleCheck, Figma, Loader2 } from 'lucide-vue-next'
import { FIGMA_HANDLE_CONFIG_KEY, type ConnectorSummary, type FigmaOauthStatusResponse } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { openOauthTab } from '@/modules/connectors/model/oauth-tab'
import { useConnectionsWait } from '@/modules/connectors/model/use-connections-wait'

const props = defineProps<{ connector: ConnectorSummary }>()
const { t } = useI18n()
const queryClient = useQueryClient()

const status = useQuery(
  computed(() => apiQueryOptions('/v1/connectors/figma/oauth', { query: { workspaceId: props.connector.workspaceId } })),
)
const configured = computed(() => (status.data.value as FigmaOauthStatusResponse | undefined)?.configured ?? false)
const handle = computed(() => props.connector.config[FIGMA_HANDLE_CONFIG_KEY] ?? null)

const refresh = () => queryClient.invalidateQueries({ queryKey: ['/v1/connectors'] })
// A finished authorisation touches the workspace's Figma connection (#564):
// the long poll sees it whether or not this tab has focus.
const wait = useConnectionsWait(() => {
  wait.stop()
  void refresh()
})
const connecting = ref(false)

async function connect() {
  connecting.value = true
  try {
    await openOauthTab(async () => {
      const res = await api.get('/v1/connectors/{id}/figma/authorize', {
        path: { id: props.connector.id },
        query: { returnTo: `/settings/connectors/${props.connector.id}` },
      })
      return res.url
    }, () => undefined)
    wait.start()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    connecting.value = false
  }
}

const disconnect = useApiMutation('delete', '/v1/connectors/{id}/figma/grant', {
  invalidates: () => [['/v1/connectors']],
})
async function forget() {
  try {
    await disconnect.mutateAsync({ path: { id: props.connector.id } })
    toast.success(t('connectors.figmaAccess.disconnected'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <section v-if="configured || handle" class="space-y-3 rounded-lg border px-4 py-3">
    <h2 class="flex items-center gap-1.5 text-sm font-medium">
      <Figma class="size-4 shrink-0" aria-hidden="true" />
      {{ t('connectors.figmaAccess.title') }}
    </h2>

    <template v-if="handle">
      <div class="space-y-0.5 text-sm">
        <p class="flex min-w-0 items-center gap-1.5">
          <CircleCheck class="text-panel-tip-ink size-3.5 shrink-0" aria-hidden="true" />
          <span class="truncate">{{ t('connectors.figmaAccess.connectedAs', { handle }) }}</span>
        </p>
        <p class="text-muted-foreground text-xs">{{ t('connectors.figmaAccess.connectedHint') }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button v-if="configured" variant="outline" size="sm" :disabled="connecting" @click="connect">
          <Loader2 v-if="connecting" class="size-3.5 animate-spin" aria-hidden="true" />
          {{ t('connectors.figmaAccess.reconnect') }}
        </Button>
        <Button variant="ghost" size="sm" :disabled="disconnect.isPending.value" @click="forget">
          {{ t('connectors.figmaAccess.disconnect') }}
        </Button>
      </div>
    </template>

    <template v-else>
      <p class="text-muted-foreground text-xs">
        {{ connector.hasCredential ? t('connectors.figmaAccess.usesToken') : t('connectors.figmaAccess.noCredential') }}
      </p>
      <Button variant="outline" size="sm" class="w-full" :disabled="connecting" @click="connect">
        <Loader2 v-if="connecting" class="size-3.5 animate-spin" aria-hidden="true" />
        <Figma v-else class="size-3.5" aria-hidden="true" />
        {{ t('connectors.figmaAccess.connect') }}
      </Button>
    </template>
  </section>
</template>
