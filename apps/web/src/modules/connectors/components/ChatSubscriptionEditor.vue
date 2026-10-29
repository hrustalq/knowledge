<script setup lang="ts">
/**
 * What one bound group is told about (issue #71, phase 3): pages published or
 * updated, merge requests opened or merged, in a project and/or under some
 * tags, right away or as a digest. Saves as it changes, like the binding row
 * it sits under. Only titles and links ever reach the group — the hint says
 * so, because an admin deciding what a group hears needs to know that.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Plus, Trash2 } from 'lucide-vue-next'
import {
  CHAT_DIGEST_MINUTES,
  CHAT_SUBSCRIPTION_EVENT_KINDS,
  type ChatSubscriptionEntry,
  type ChatSubscriptionEventKind,
  type ChatSubscriptionsResponse,
} from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { formatRelative } from '@/shared/utils/format'
import { tagLabel, useTagOptions } from '@/modules/documents/model/tag-options'
import { useProjectsStore } from '@/stores/projects'
import { Autocomplete } from '@/shared/ui/autocomplete'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'

const loadTagOptions = useTagOptions()

const props = defineProps<{ bindingId: string; defaultProjectId: string | null }>()
const emit = defineEmits<{ changed: [] }>()
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const projects = useProjectsStore()

const options = computed(() =>
  apiQueryOptions('/v1/chat/bindings/{id}/subscriptions', { path: { id: props.bindingId } }),
)
const query = useQuery(options)
const subscriptions = computed(() => (query.data.value as ChatSubscriptionsResponse | undefined)?.subscriptions ?? [])

const WHOLE = '__whole'
const INSTANT = 'instant'
/** Delivery and window are one choice to the reader: "right away" or a digest period. */
const timing = (s: ChatSubscriptionEntry) => (s.delivery === 'digest' ? `digest:${s.digestMinutes}` : INSTANT)
const timingBody = (v: string) =>
  v === INSTANT ? { delivery: 'instant' } : { delivery: 'digest', digestMinutes: Number(v.split(':')[1]) }

function refresh() {
  void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
}

async function patch(s: ChatSubscriptionEntry, body: Record<string, unknown>) {
  try {
    await api.patch('/v1/chat/subscriptions/{id}', { path: { id: s.id }, body })
    refresh()
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

function toggleKind(s: ChatSubscriptionEntry, kind: ChatSubscriptionEventKind, on: boolean) {
  const next = on ? [...s.eventKinds, kind] : s.eventKinds.filter((k) => k !== kind)
  // A rule about nothing is not a rule; the last box stays ticked.
  if (next.length === 0) return
  void patch(s, { eventKinds: CHAT_SUBSCRIPTION_EVENT_KINDS.filter((k) => next.includes(k)) })
}

async function remove(s: ChatSubscriptionEntry) {
  try {
    await api.delete('/v1/chat/subscriptions/{id}', { path: { id: s.id } })
    refresh()
    emit('changed')
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

const adding = ref(false)
async function add() {
  if (adding.value) return
  adding.value = true
  try {
    await api.post('/v1/chat/bindings/{id}/subscriptions', {
      path: { id: props.bindingId },
      body: { projectId: props.defaultProjectId, eventKinds: ['page-published', 'page-updated'] },
    })
    refresh()
    emit('changed')
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    adding.value = false
  }
}

function status(s: ChatSubscriptionEntry): string {
  void locale.value
  return s.lastDeliveredAt
    ? t('chatBots.subscriptions.lastSent', { when: formatRelative(s.lastDeliveredAt) })
    : t('chatBots.subscriptions.neverSent')
}
</script>

<template>
  <div class="space-y-2.5">
    <p class="text-xs text-muted-foreground">{{ t('chatBots.subscriptions.hint') }}</p>

    <ul v-if="subscriptions.length" class="space-y-2">
      <li v-for="s in subscriptions" :key="s.id" class="rounded-md border bg-muted/30 px-3 py-2.5">
        <div class="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-end">
          <div class="grid min-w-0 gap-1">
            <span class="text-xs text-muted-foreground">{{ t('chatBots.fields.project') }}</span>
            <Select
              :model-value="s.projectId ?? WHOLE"
              @update:model-value="(v) => patch(s, { projectId: v === WHOLE ? null : v })"
            >
              <SelectTrigger class="h-8 w-full text-xs" :aria-label="t('chatBots.fields.project')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="WHOLE">{{ t('chatBots.bindings.wholeWorkspace') }}</SelectItem>
                <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="min-w-0">
            <Autocomplete
              :model-value="s.tags.map((tag) => `tag:${tag}`)"
              :label="t('chatBots.subscriptions.tags')"
              :placeholder="t('chatBots.subscriptions.anyTag')"
              :load="loadTagOptions"
              :fallback-label="tagLabel"
              :empty-hint="t('hints.tagsFromFrontmatter')"
              @update:model-value="(v: string[]) => patch(s, { tags: v })"
            />
          </div>
          <div class="grid min-w-0 gap-1">
            <span class="text-xs text-muted-foreground">{{ t('chatBots.subscriptions.timing') }}</span>
            <Select :model-value="timing(s)" @update:model-value="(v) => patch(s, timingBody(String(v)))">
              <SelectTrigger class="h-8 w-full text-xs" :aria-label="t('chatBots.subscriptions.timing')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="INSTANT">{{ t('chatBots.subscriptions.instant') }}</SelectItem>
                <SelectItem v-for="m in CHAT_DIGEST_MINUTES" :key="m" :value="`digest:${m}`">
                  {{ t(`chatBots.subscriptions.digest.${m}`) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="ghost"
            size="icon"
            class="size-8 justify-self-end"
            :aria-label="t('chatBots.subscriptions.remove')"
            @click="remove(s)"
          >
            <Trash2 class="size-4" />
          </Button>
        </div>

        <fieldset class="mt-2.5">
          <legend class="text-xs text-muted-foreground">{{ t('chatBots.subscriptions.events') }}</legend>
          <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
            <label
              v-for="kind in CHAT_SUBSCRIPTION_EVENT_KINDS"
              :key="kind"
              class="flex cursor-pointer items-center gap-1.5 text-xs"
            >
              <Checkbox
                :model-value="s.eventKinds.includes(kind)"
                @update:model-value="(on) => toggleKind(s, kind, on === true)"
              />
              {{ t(`chatBots.subscriptions.kind.${kind}`) }}
            </label>
          </div>
        </fieldset>

        <p class="mt-2 text-xs text-muted-foreground">{{ status(s) }}</p>
        <p v-if="s.lastError" class="mt-1 text-xs text-destructive">
          {{ t('chatBots.subscriptions.refused', { error: s.lastError }) }}
        </p>
      </li>
    </ul>
    <p v-else-if="query.isSuccess.value" class="text-sm text-muted-foreground">{{ t('chatBots.subscriptions.none') }}</p>

    <Button size="sm" variant="outline" :disabled="adding" @click="add">
      <Plus class="size-4" />{{ t('chatBots.subscriptions.add') }}
    </Button>
  </div>
</template>
