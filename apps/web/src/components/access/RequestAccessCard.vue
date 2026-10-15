<script setup lang="ts">
/**
 * What a member sees on a page or project they were refused (#76, phase 5):
 * the calm "restricted" state, plus a way to ask.
 *
 * It first asks whether the caller already has a pending request for this
 * node, so a reload shows "waiting" rather than offering to ask twice (the API
 * would answer 409 anyway). The node's name is never shown — the API never
 * sent it. A guest never lands here: they are answered 404, not 403.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Lock } from 'lucide-vue-next'
import type {
  AccessResourceType,
  ListAccessRequestsResponse,
  RequestableAccessLevel,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { errorMessage } from '@/api/errors'
import { formatRelative } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import PageState from '@/components/layout/page/PageState.vue'

const { t } = useI18n()

const props = defineProps<{
  resourceType: AccessResourceType
  resourceId: string
}>()

const workspaceId = getWorkspaceId()
const queryClient = useQueryClient()
const key = computed(() => [
  '/v1/access-requests',
  null,
  { workspaceId, mine: true, resourceType: props.resourceType, resourceId: props.resourceId },
])
const mine = useQuery({
  queryKey: key,
  queryFn: () =>
    apiFetch<ListAccessRequestsResponse>(
      `/v1/access-requests?${new URLSearchParams({
        workspaceId,
        mine: '1',
        resourceType: props.resourceType,
        resourceId: props.resourceId,
      })}`,
    ),
})
const pending = computed(() => mine.data.value?.requests.find((r) => r.status === 'pending') ?? null)
const lastDenied = computed(() => {
  const latest = mine.data.value?.requests[0]
  return latest?.status === 'denied' ? latest : null
})

const level = ref<RequestableAccessLevel>('view')
const message = ref('')
const busy = ref(false)

async function send() {
  busy.value = true
  try {
    await apiFetch('/v1/access-requests', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        resourceType: props.resourceType,
        resourceId: props.resourceId,
        level: level.value,
        message: message.value.trim() || null,
      }),
    })
    toast.success(t('access.request.sent'))
    message.value = ''
    await queryClient.invalidateQueries({ queryKey: ['/v1/access-requests'] })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

async function withdraw() {
  if (!pending.value) return
  busy.value = true
  try {
    await apiFetch(`/v1/access-requests/${pending.value.requestId}/cancel`, { method: 'POST', body: '{}' })
    toast.success(t('access.requests.cancelled'))
    await queryClient.invalidateQueries({ queryKey: ['/v1/access-requests'] })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <PageState
    state="forbidden"
    :icon="Lock"
    :title="pending ? t('access.request.pendingTitle') : t('access.restrictedTitle')"
    :description="
      pending ? t('access.request.pendingBody', { when: formatRelative(pending.createdAt) }) : t('access.restrictedBody')
    "
  >
    <template #actions>
      <Button v-if="pending" variant="outline" size="sm" :disabled="busy" @click="withdraw">
        {{ t('access.request.withdraw') }}
      </Button>
      <form
        v-else-if="!mine.isPending.value"
        class="mt-2 w-full max-w-sm space-y-3 text-left"
        @submit.prevent="send"
      >
        <p v-if="lastDenied" class="text-sm text-muted-foreground">{{ t('access.request.deniedNote') }}</p>
        <div class="space-y-1.5">
          <Label for="request-level">{{ t('access.request.levelLabel') }}</Label>
          <Select v-model="level">
            <SelectTrigger id="request-level"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="view">{{ t('access.level.view') }}</SelectItem>
              <SelectItem value="edit">{{ t('access.level.edit') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="space-y-1.5">
          <Label for="request-message">{{ t('access.request.messageLabel') }}</Label>
          <Textarea
            id="request-message"
            v-model="message"
            rows="3"
            maxlength="1000"
            :placeholder="t('access.request.messagePlaceholder')"
          />
        </div>
        <Button type="submit" size="sm" class="w-full" :disabled="busy">{{ t('access.request.send') }}</Button>
      </form>
    </template>
  </PageState>
</template>
