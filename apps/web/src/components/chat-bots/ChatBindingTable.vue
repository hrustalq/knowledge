<script setup lang="ts">
/**
 * The groups one bot answers in (issue #71), each with its own project scope,
 * agent, answer mode and language. Every change saves as it is made — there is
 * no form to forget to submit. A group is usually added from inside it, with
 * /bind; typing its id here is the fallback.
 *
 * A Telegram group can also keep its messages for a harvest (#82): the API
 * posts a notice in the group before it keeps anything, so the toggle waits
 * for that round trip and shows the refusal if the bot cannot speak there.
 *
 * A listening group can also be harvested automatically (#340), as the admin
 * who turns that on: the API tells the group first, so that switch waits too.
 * The server's ceiling is shown beside the switch, not folded into it — a
 * binding that asks for it on a server that has it off says both.
 *
 * Any group can be made searchable (#339), separately from listening: the API
 * tells the group first, and the row names who switched it on and when.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Bell, ChevronDown, Trash2 } from 'lucide-vue-next'
import {
  CHAT_ANSWER_MODES,
  SUPPORTED_LOCALES,
  type ChatBindingEntry,
  type ChatBindingsResponse,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatDate } from '@/lib/format'
import UserChip from '@/components/people/UserChip.vue'
import AgentSelect from './AgentSelect.vue'
import ChatSubscriptionEditor from './ChatSubscriptionEditor.vue'

const props = defineProps<{ integrationId: string; kind: string }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const queryClient = useQueryClient()
const projects = useProjectsStore()
onMounted(() => {
  if (!projects.loaded) void projects.fetchList()
})

const options = computed(() => apiQueryOptions('/v1/chat/integrations/{id}/bindings', { path: { id: props.integrationId } }))
const query = useQuery(options)
const bindings = computed(() => (query.data.value as ChatBindingsResponse | undefined)?.bindings ?? [])
const ttlDays = computed(() => (query.data.value as ChatBindingsResponse | undefined)?.listenTtlDays ?? 7)
const auto = computed(() => (query.data.value as ChatBindingsResponse | undefined)?.autoHarvest ?? null)
const search = computed(() => (query.data.value as ChatBindingsResponse | undefined)?.search ?? null)
const searchHint = computed(() => {
  const days = search.value?.retentionDays.applied ?? 0
  return t('chatBots.bindings.searchableHint', { days: t('chatBots.bindings.listenDays', { days }, days) })
})
const autoHint = computed(() => {
  const a = auto.value
  if (!a) return ''
  return t('chatBots.bindings.autoHarvestHint', {
    messages: t('chatBots.bindings.autoHarvestMessages', { n: a.minMessages }, a.minMessages),
    quiet: t('chatBots.bindings.autoHarvestQuiet', { n: a.quietMinutes }, a.quietMinutes),
  })
})

/** Which bindings have their notification rules open. */
const open = reactive<Record<string, boolean>>({})
function refresh() {
  void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
}

const WHOLE = '__whole'
const INHERIT = '__inherit'

async function patch(b: ChatBindingEntry, body: Record<string, unknown>) {
  try {
    await api.patch('/v1/chat/bindings/{id}', { path: { id: b.id }, body })
    void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

/** Bindings whose listening switch is waiting on the API (and, turning on, on the group notice). */
const switching = reactive<Record<string, boolean>>({})
async function setListening(b: ChatBindingEntry, on: boolean) {
  await setSwitch(b, { listening: on })
}

/** Automatic harvest: whoever turns it on is who it runs as, so the body carries only the switch. */
async function setAutoHarvest(b: ChatBindingEntry, on: boolean) {
  await setSwitch(b, { autoHarvest: on })
}

async function setSwitch(b: ChatBindingEntry, body: Record<string, boolean>) {
  switching[b.id] = true
  try {
    await patch(b, body)
  } finally {
    switching[b.id] = false
    // A refusal (the bot could not tell the group) must put the box back to what the server holds.
    refresh()
  }
}

async function remove(b: ChatBindingEntry) {
  try {
    await api.delete('/v1/chat/bindings/{id}', { path: { id: b.id } })
    void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
    emit('changed')
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

const draft = reactive({ chatId: '', title: '' })
const adding = ref(false)
async function add() {
  if (!draft.chatId.trim() || adding.value) return
  adding.value = true
  try {
    await api.post('/v1/chat/integrations/{id}/bindings', {
      path: { id: props.integrationId },
      body: { externalChatId: draft.chatId.trim(), title: draft.title.trim() || null },
    })
    Object.assign(draft, { chatId: '', title: '' })
    void queryClient.invalidateQueries({ queryKey: options.value.queryKey })
    emit('changed')
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <p class="text-xs text-muted-foreground">{{ t('chatBots.bindings.hint') }}</p>

    <ul v-if="bindings.length" class="divide-y rounded-md border">
      <!-- Identity on top, settings beneath: the group is what the row is
           about, so its name must never be the column that gives way. -->
      <li v-for="b in bindings" :key="b.id" class="px-3 py-3">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium" :title="b.title ?? undefined">{{ b.title || t('chatBots.bindings.untitled') }}</p>
            <p class="truncate font-mono text-xs text-muted-foreground">{{ b.externalChatId }}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            class="size-8 shrink-0"
            :aria-label="t('common.removeNamed', { name: b.title || b.externalChatId })"
            @click="remove(b)"
          >
            <Trash2 class="size-4" />
          </Button>
        </div>
        <div class="mt-2.5 grid gap-x-3 gap-y-2 sm:grid-cols-2 xl:grid-cols-4">
          <div class="grid min-w-0 gap-1">
            <span class="text-xs text-muted-foreground">{{ t('chatBots.fields.project') }}</span>
            <Select
              :model-value="b.projectId ?? WHOLE"
              @update:model-value="(v) => patch(b, { projectId: v === WHOLE ? null : v })"
            >
              <SelectTrigger class="h-8 w-full text-xs" :aria-label="t('chatBots.fields.project')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="WHOLE">{{ t('chatBots.bindings.wholeWorkspace') }}</SelectItem>
                <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid min-w-0 gap-1">
            <span class="text-xs text-muted-foreground">{{ t('chatBots.fields.agentShort') }}</span>
            <AgentSelect
              :model-value="b.agentKey"
              compact
              :default-label="t('chatBots.bindings.botDefault')"
              @update:model-value="(v) => patch(b, { agentKey: v })"
            />
          </div>
          <div class="grid min-w-0 gap-1">
            <span class="text-xs text-muted-foreground">{{ t('chatBots.fields.answerMode') }}</span>
            <Select :model-value="b.answerMode" @update:model-value="(v) => patch(b, { answerMode: v })">
              <SelectTrigger class="h-8 w-full text-xs" :aria-label="t('chatBots.fields.answerMode')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="m in CHAT_ANSWER_MODES" :key="m" :value="m">{{ t(`chatBots.answerMode.${m}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid min-w-0 gap-1">
            <span class="text-xs text-muted-foreground">{{ t('chatBots.fields.locale') }}</span>
            <Select
              :model-value="b.locale ?? INHERIT"
              @update:model-value="(v) => patch(b, { locale: v === INHERIT ? null : v })"
            >
              <SelectTrigger class="h-8 w-full text-xs" :aria-label="t('chatBots.fields.locale')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="INHERIT">{{ t('chatBots.bindings.botLocale') }}</SelectItem>
                <SelectItem v-for="l in SUPPORTED_LOCALES" :key="l" :value="l">{{ t(`chatBots.locale.${l}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <label
          v-if="kind === 'telegram'"
          class="mt-3 flex max-w-[46rem] cursor-pointer items-start gap-2.5 has-[:disabled]:cursor-progress"
        >
          <Checkbox
            class="mt-0.5"
            :model-value="b.listening"
            :disabled="!!switching[b.id]"
            @update:model-value="(v) => setListening(b, v === true)"
          />
          <span class="min-w-0">
            <span class="block text-sm">{{ t('chatBots.bindings.listen') }}</span>
            <span class="block text-xs text-muted-foreground">
              {{ t('chatBots.bindings.listenHint', { days: t('chatBots.bindings.listenDays', { days: ttlDays }, ttlDays) }) }}
            </span>
          </span>
        </label>
        <label
          v-if="kind === 'telegram' && auto"
          class="mt-3 flex max-w-[46rem] items-start gap-2.5"
          :class="b.listening && (auto.available || b.autoHarvestBy) ? 'cursor-pointer has-[:disabled]:cursor-progress' : 'cursor-not-allowed'"
        >
          <Checkbox
            class="mt-0.5"
            :model-value="!!b.autoHarvestBy"
            :disabled="!!switching[b.id] || !b.listening || (!auto.available && !b.autoHarvestBy)"
            @update:model-value="(v) => setAutoHarvest(b, v === true)"
          />
          <span class="min-w-0">
            <span class="block text-sm">{{ t('chatBots.bindings.autoHarvest') }}</span>
            <span class="block text-xs text-muted-foreground">{{ autoHint }}</span>
            <span v-if="!b.listening" class="mt-1 block text-xs text-muted-foreground">{{ t('chatBots.bindings.autoHarvestNeedsListening') }}</span>
            <span v-if="!auto.available" class="mt-1 block text-xs text-panel-warning-ink">{{ t('chatBots.bindings.autoHarvestUnavailable') }}</span>
          </span>
        </label>
        <!-- Outside the label: the chip opens a card, and a control inside a label is invalid markup. -->
        <div v-if="kind === 'telegram' && b.autoHarvestBy" class="mt-1 flex items-center gap-1.5 pl-[1.625rem] text-xs text-muted-foreground">
          {{ t('chatBots.bindings.autoHarvestRunsAs') }}
          <UserChip :user-id="b.autoHarvestBy" size="sm" />
        </div>
        <label
          v-if="search"
          class="mt-3 flex max-w-[46rem] items-start gap-2.5"
          :class="search.available || b.searchableAt ? 'cursor-pointer has-[:disabled]:cursor-progress' : 'cursor-not-allowed'"
        >
          <Checkbox
            class="mt-0.5"
            :model-value="!!b.searchableAt"
            :disabled="!!switching[b.id] || (!search.available && !b.searchableAt)"
            @update:model-value="(v) => setSwitch(b, { searchable: v === true })"
          />
          <span class="min-w-0">
            <span class="block text-sm">{{ t('chatBots.bindings.searchable') }}</span>
            <span class="block text-xs text-muted-foreground">{{ searchHint }}</span>
            <span v-if="kind === 'telegram'" class="mt-1 block text-xs text-muted-foreground">{{ t('chatBots.bindings.searchableTelegram') }}</span>
            <span v-if="!search.available" class="mt-1 block text-xs text-panel-warning-ink">{{ t('chatBots.bindings.searchableUnavailable') }}</span>
          </span>
        </label>
        <!-- Outside the label, as above: the chip opens a card. -->
        <div v-if="b.searchableBy && b.searchableAt" class="mt-1 flex flex-wrap items-center gap-1.5 pl-[1.625rem] text-xs text-muted-foreground">
          {{ t('chatBots.bindings.searchableBy') }}
          <UserChip :user-id="b.searchableBy" size="sm" />
          <span>· {{ formatDate(b.searchableAt) }}</span>
        </div>
        <button
          type="button"
          class="mt-2.5 inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          :aria-expanded="!!open[b.id]"
          @click="open[b.id] = !open[b.id]"
        >
          <Bell class="size-3.5" />
          {{ t('chatBots.subscriptions.toggle', { n: b.subscriptionCount }) }}
          <ChevronDown class="size-3.5 transition-transform" :class="open[b.id] ? 'rotate-180' : ''" />
        </button>
        <ChatSubscriptionEditor
          v-if="open[b.id]"
          class="mt-2"
          :binding-id="b.id"
          :default-project-id="b.projectId"
          @changed="refresh"
        />
      </li>
    </ul>
    <p v-else-if="query.isSuccess.value" class="text-sm text-muted-foreground">{{ t('chatBots.bindings.none') }}</p>

    <form class="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end" @submit.prevent="add">
      <div class="grid gap-1">
        <Label :for="`chat-id-${integrationId}`" class="text-xs font-normal text-muted-foreground">{{ t('chatBots.fields.chatId') }}</Label>
        <Input :id="`chat-id-${integrationId}`" v-model="draft.chatId" class="h-8 font-mono text-xs" :placeholder="t(kind === 'slack' ? 'chatBots.bindings.chatIdPlaceholderSlack' : 'chatBots.bindings.chatIdPlaceholder')" />
      </div>
      <div class="grid gap-1">
        <Label :for="`chat-title-${integrationId}`" class="text-xs font-normal text-muted-foreground">{{ t('chatBots.fields.chatTitle') }}</Label>
        <Input :id="`chat-title-${integrationId}`" v-model="draft.title" class="h-8 text-xs" maxlength="200" :placeholder="t('chatBots.bindings.titlePlaceholder')" />
      </div>
      <Button type="submit" size="sm" variant="outline" class="justify-self-start" :disabled="!draft.chatId.trim() || adding">{{ t('chatBots.bindings.add') }}</Button>
    </form>
  </div>
</template>
