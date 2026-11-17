<script setup lang="ts">
/**
 * The wizard's live config (#1225): the real text for the chosen client —
 * the variable, the one-liner, the file — re-rendered on every answer. A block
 * an answer just changed is tinted for a moment, so "what did that do?" is
 * answered where the person is already looking.
 */
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink } from 'lucide-vue-next'
import { CopyBlock, KEY_ENV, type McpClientGuide } from '@/entities/access'

const props = defineProps<{
  url: string
  client: McpClientGuide | null
  needsKey: boolean
  /** The key minted in this wizard, while it is on screen. */
  apiKey: string | null
}>()
const { t } = useI18n()

interface Block {
  id: string
  label: string
  code: string
  secret?: boolean
}

const blocks = computed<Block[]>(() => {
  const c = props.client
  if (!c) return []
  return [
    ...(c.usesEnv
      ? [{ id: 'env', label: t('connect.clients.step.env'), code: `export ${KEY_ENV}=${props.apiKey ?? '<your-api-key>'}`, secret: !!props.apiKey }]
      : []),
    ...(c.command ? [{ id: 'command', label: t('connect.clients.step.command'), code: c.command }] : []),
    { id: 'file', label: c.config.path, code: c.config.code, secret: !c.usesEnv && !!props.apiKey },
  ]
})

/** Placeholder still in a file the client cannot point at a variable. */
const placeholder = computed(
  () => props.needsKey && !!props.client && !props.client.usesEnv && props.client.id !== 'vscode' && !props.apiKey,
)

const flashing = reactive(new Set<string>())
const timers = new Map<string, ReturnType<typeof setTimeout>>()
watch(
  () => blocks.value.map((b) => [b.id, b.code] as const),
  (now, before) => {
    const old = new Map(before)
    for (const [id, code] of now) {
      if (!old.has(id) || old.get(id) === code) continue
      clearTimeout(timers.get(id))
      flashing.add(id)
      timers.set(id, setTimeout(() => flashing.delete(id), 1200))
    }
  },
)
onBeforeUnmount(() => timers.forEach(clearTimeout))
</script>

<template>
  <div class="grid min-w-0 gap-3">
    <CopyBlock :code="url" :label="t('connect.wizard.pane.endpoint')" />

    <p v-if="!client" class="rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
      {{ t('connect.wizard.pane.empty') }}
    </p>

    <template v-else>
      <div v-for="b in blocks" :key="b.id" class="min-w-0 rounded-lg" :class="{ 'kn-flash': flashing.has(b.id) }">
        <CopyBlock :code="b.code" :label="b.label" :secret="b.secret" />
      </div>
      <p v-if="placeholder" class="text-caption text-panel-warning-ink">{{ t('connect.clients.placeholder') }}</p>
      <p class="text-caption text-muted-foreground">
        {{ t(`connect.clients.notes.${client.note}`) }}
        <a :href="client.docs" target="_blank" rel="noopener noreferrer" class="ml-1 inline-flex items-center gap-0.5 text-primary underline underline-offset-2">
          {{ t('connect.clients.docs') }}<ExternalLink class="size-3" aria-hidden="true" />
        </a>
      </p>
    </template>
  </div>
</template>

<style scoped>
.kn-flash {
  animation: kn-flash 1.2s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes kn-flash {
  from {
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 28%, transparent);
    background: color-mix(in oklab, var(--primary) 8%, transparent);
  }
  to {
    box-shadow: 0 0 0 3px transparent;
    background: transparent;
  }
}
/* No fade, but the change is still marked for as long as the tint would have lasted. */
@media (prefers-reduced-motion: reduce) {
  .kn-flash {
    animation: none;
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--primary) 35%, transparent);
  }
}
</style>
