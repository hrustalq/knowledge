<script setup lang="ts">
/**
 * Designing a chain by describing it.
 *
 * Shaped like the assistant's transcript — turns in a scrolling column, a
 * composer pinned at the bottom, the same voice — but deliberately smaller than
 * `ChatPane`: there is no thread rail, no tool trail and no persistence,
 * because this conversation exists to produce one definition and ends when it
 * has. Reusing the chat components would have meant reusing the thread store
 * they are built on, which would file a saved chat next to the workflow it
 * produced — the same fact in two places, and the copy nobody maintains.
 *
 * Each turn returns a question *or* a proposal. A proposal is compiled on the
 * server before it arrives, so what lands on the canvas beside this column is
 * always something that would save.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Bot, Loader2, TriangleAlert } from 'lucide-vue-next'
import type { DraftWorkflowResponse, WorkflowGraph } from '@knowledge/contracts'
import { api, type Op, type RequestOptions } from '@/api/client'
import { getProjectId, getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { WizardTurn } from './wizard-machine'

const props = defineProps<{
  turns: WizardTurn[]
  graph: WorkflowGraph | null
  disabled: boolean
}>()

const emit = defineEmits<{
  say: [WizardTurn]
  propose: [{ graph: WorkflowGraph; name: string | null; description: string | null }]
  unavailable: []
}>()

const { t } = useI18n()

const input = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const scroller = ref<HTMLElement | null>(null)

/** Openers, so the first turn is a choice rather than a blank box. */
const SEEDS = ['seedEntity', 'seedProcess', 'seedContract'] as const

const canSend = computed(() => !busy.value && !props.disabled && input.value.trim().length > 1)

async function send(text?: string) {
  const content = (text ?? input.value).trim()
  if (!content || busy.value || props.disabled) return
  input.value = ''
  error.value = null
  emit('say', { role: 'user', content })
  await scrollDown()

  busy.value = true
  try {
    // `WorkflowGraphDto.steps` is a loose object array in the OpenAPI schema —
    // Swagger cannot express the step union — so the body is cast here rather
    // than the contract weakened, which is the house pattern for this.
    const body = {
      workspaceId: getWorkspaceId(),
      projectId: getProjectId(),
      // The turn just emitted is not in props yet — the parent applies it on
      // the next tick — so it is appended here rather than read back.
      messages: [...props.turns, { role: 'user' as const, content }],
      ...(props.graph ? { graph: props.graph } : {}),
    }
    const res = (await api.post('/v1/workflows/draft', {
      body: body as unknown as RequestOptions<Op<'/v1/workflows/draft', 'post'>>['body'],
    })) as DraftWorkflowResponse

    if (!res.enabled) {
      emit('unavailable')
      return
    }
    if (res.reply) emit('say', { role: 'assistant', content: res.reply })
    if (res.graph) emit('propose', { graph: res.graph, name: res.name, description: res.description })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
    await scrollDown()
  }
}

async function scrollDown() {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(() => props.turns.length, scrollDown)

function onKeydown(event: KeyboardEvent) {
  // Enter sends, Shift+Enter breaks the line — the composer convention, and the
  // one this product's own chat already uses.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
}

defineExpose({ send })
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <div ref="scroller" class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
      <!-- First run: say what this is for and hand over three ways to start.
           An empty transcript with a blinking box teaches nothing. -->
      <div v-if="!turns.length" class="space-y-4">
        <div class="flex gap-2.5">
          <span class="bg-primary/10 text-primary mt-0.5 grid size-7 shrink-0 place-items-center rounded-full">
            <Bot class="size-4" />
          </span>
          <p class="text-sm leading-relaxed">{{ t('workflow.wizard.architectOpener') }}</p>
        </div>
        <ul class="space-y-1.5 pl-9.5">
          <li v-for="seed in SEEDS" :key="seed">
            <button
              type="button"
              class="hover:bg-muted/60 focus-visible:ring-ring hover:border-primary/30 w-full rounded-lg border px-3 py-2 text-left text-[13px] leading-snug transition-colors focus-visible:ring-2 focus-visible:outline-none"
              :disabled="disabled"
              @click="send(t(`workflow.wizard.${seed}`))"
            >
              {{ t(`workflow.wizard.${seed}`) }}
            </button>
          </li>
        </ul>
      </div>

      <div v-for="(turn, i) in turns" :key="i" class="flex gap-2.5">
        <span
          v-if="turn.role === 'assistant'"
          class="bg-primary/10 text-primary mt-0.5 grid size-7 shrink-0 place-items-center rounded-full"
        >
          <Bot class="size-4" />
        </span>
        <p
          class="text-sm leading-relaxed"
          :class="
            turn.role === 'user'
              ? 'bg-muted ml-auto max-w-[85%] rounded-xl rounded-br-sm px-3 py-2'
              : 'min-w-0 flex-1 pt-0.5'
          "
        >
          {{ turn.content }}
        </p>
      </div>

      <p v-if="busy" class="text-muted-foreground flex items-center gap-2 pl-9.5 text-sm">
        <Loader2 class="size-3.5 animate-spin" />
        {{ t('workflow.wizard.thinking') }}
      </p>

      <p v-if="error" class="text-destructive bg-destructive/5 flex gap-1.5 rounded-md border px-3 py-2 text-xs">
        <TriangleAlert class="mt-px size-3.5 shrink-0" />
        <span class="min-w-0 flex-1">{{ error }}</span>
      </p>
    </div>

    <div class="shrink-0 border-t p-3">
      <div class="focus-within:border-primary focus-within:ring-ring/50 flex items-end gap-2 rounded-lg border px-2 py-1.5 transition-[color,box-shadow] focus-within:ring-[3px]">
        <Textarea
          v-model="input"
          rows="1"
          :disabled="disabled || busy"
          :placeholder="turns.length ? t('workflow.wizard.followUp') : t('workflow.wizard.describePlaceholder')"
          class="max-h-32 min-h-8 resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
          @keydown="onKeydown"
        />
        <Button size="sm" class="size-8 shrink-0 p-0" :disabled="!canSend" :aria-label="t('common.send')" @click="send()">
          <ArrowUp class="size-4" />
        </Button>
      </div>
      <p class="text-muted-foreground mt-1.5 px-1 text-[11px] leading-snug">
        {{ t('workflow.wizard.composerHint') }}
      </p>
    </div>
  </div>
</template>
