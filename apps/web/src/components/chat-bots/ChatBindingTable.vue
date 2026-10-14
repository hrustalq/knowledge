<script setup lang="ts">
/**
 * The groups one bot answers in (issue #71), each with its own project scope,
 * agent, answer mode and language. Every change saves as it is made — there is
 * no form to forget to submit. A group is usually added from inside it, with
 * /bind; typing its id here is the fallback.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Trash2 } from 'lucide-vue-next'
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
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import AgentSelect from './AgentSelect.vue'

const props = defineProps<{ integrationId: string }>()
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
      <li v-for="b in bindings" :key="b.id" class="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_repeat(4,11rem)_auto] lg:items-center">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">{{ b.title || t('chatBots.bindings.untitled') }}</p>
          <p class="truncate font-mono text-xs text-muted-foreground">{{ b.externalChatId }}</p>
        </div>
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
        <AgentSelect
          :model-value="b.agentKey"
          compact
          :default-label="t('chatBots.bindings.botDefault')"
          @update:model-value="(v) => patch(b, { agentKey: v })"
        />
        <Select :model-value="b.answerMode" @update:model-value="(v) => patch(b, { answerMode: v })">
          <SelectTrigger class="h-8 w-full text-xs" :aria-label="t('chatBots.fields.answerMode')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="m in CHAT_ANSWER_MODES" :key="m" :value="m">{{ t(`chatBots.answerMode.${m}`) }}</SelectItem>
          </SelectContent>
        </Select>
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
        <Button
          variant="ghost"
          size="icon"
          class="size-8 justify-self-end"
          :aria-label="t('common.removeNamed', { name: b.title || b.externalChatId })"
          @click="remove(b)"
        >
          <Trash2 class="size-4" />
        </Button>
      </li>
    </ul>
    <p v-else-if="query.isSuccess.value" class="text-sm text-muted-foreground">{{ t('chatBots.bindings.none') }}</p>

    <form class="flex flex-wrap items-end gap-2" @submit.prevent="add">
      <Input v-model="draft.chatId" class="h-8 w-44 font-mono text-xs" :placeholder="t('chatBots.bindings.chatIdPlaceholder')" :aria-label="t('chatBots.fields.chatId')" />
      <Input v-model="draft.title" class="h-8 w-56 text-xs" maxlength="200" :placeholder="t('chatBots.bindings.titlePlaceholder')" :aria-label="t('chatBots.fields.chatTitle')" />
      <Button type="submit" size="sm" variant="outline" :disabled="!draft.chatId.trim() || adding">{{ t('chatBots.bindings.add') }}</Button>
    </form>
  </div>
</template>
