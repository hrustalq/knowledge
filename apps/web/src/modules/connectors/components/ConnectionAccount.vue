<script setup lang="ts">
/**
 * One connection as a line (#564): provider, the upstream account, how it
 * authenticates, and the site when the provider is not one fixed host. Shared
 * by the Connections tab and the connect dialog, so an account reads the same
 * wherever it is offered.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConnectionSummary } from '@knowledge/contracts'
import { Badge } from '@/shared/ui/badge'
import { providerMeta } from '@/modules/connectors/model/connection-providers'

const props = defineProps<{ connection: Pick<ConnectionSummary, 'provider' | 'method' | 'site' | 'accountLabel' | 'accountAvatarUrl' | 'credentialHint'> }>()

const { t } = useI18n()
const meta = computed(() => providerMeta(props.connection.provider))
const provider = computed(() => meta.value.label ?? t('connectors.connections.providers.git'))
/** A backfilled token was never identified: its hint is all there is to tell it apart. */
const account = computed(() => props.connection.accountLabel ?? props.connection.credentialHint ?? t('connectors.connections.unidentified'))
const site = computed(() => props.connection.site?.replace(/^https:\/\//, '') ?? null)
</script>

<template>
  <div class="flex min-w-0 items-center gap-3">
    <span class="bg-muted text-foreground grid size-8 shrink-0 place-items-center rounded-md" aria-hidden="true">
      <component :is="meta.icon" class="size-4" />
    </span>
    <div class="min-w-0">
      <p class="flex min-w-0 items-center gap-1.5 text-sm">
        <span class="font-medium">{{ provider }}</span>
        <span class="text-muted-foreground" aria-hidden="true">·</span>
        <img
          v-if="connection.accountAvatarUrl"
          :src="connection.accountAvatarUrl"
          alt=""
          class="size-4 shrink-0 rounded-full"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
        <span class="truncate" :title="account">{{ account }}</span>
      </p>
      <p class="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
        <Badge variant="outline" class="shrink-0 px-1.5 py-0 text-[11px] font-normal">
          {{ t(`connectors.connections.methods.${connection.method}`) }}
        </Badge>
        <span v-if="site" class="truncate font-mono" :title="connection.site ?? undefined">{{ site }}</span>
      </p>
    </div>
  </div>
</template>
