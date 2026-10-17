<script setup lang="ts">
/**
 * An operation's request (#78): its code samples, and the try-it console that
 * edits them. One draft feeds both, so the sample on screen is the request the
 * console sends — less the credentials, which a sample never carries.
 *
 * The console mounts only when asked for. A spec of 300 operations renders 300
 * samples, not 300 forms, and the server render never contains a field.
 */
import { computed, reactive, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Play, X } from 'lucide-vue-next'
import {
  apiServerOptions,
  codeSamplesFor,
  sampleRequestFor,
  type ApiOperationInfo,
  type SampleInputs,
} from '@knowledge/contracts'
import type { OperationView } from '@/lib/api-spec'
import { Button } from '@/components/ui/button'
import ApiCodeSamples from './ApiCodeSamples.vue'
import ApiTryConsole from './ApiTryConsole.vue'
import { useTryEnv, type TryDraft } from './use-try-env'

const props = defineProps<{
  document: Record<string, unknown>
  operation: ApiOperationInfo
  view: OperationView
  workspaceId: string
}>()
const { t } = useI18n()
const uid = useId()

const env = useTryEnv(props.operation.documentId)
const servers = computed(() => apiServerOptions(props.document))
const serverUrl = computed(() => servers.value.find((s) => s.url === env.serverUrl)?.url ?? servers.value[0]?.url ?? null)

/** The spec's own examples for what is required; never a value invented from a type. */
function initialDraft(): TryDraft {
  const pick = (where: string, all: boolean) =>
    Object.fromEntries(
      props.view.parameters
        .filter((p) => p.in === where && (all || p.required))
        .map((p) => [p.name, p.example ?? '']),
    )
  const sample = sampleRequestFor(props.document, props.operation)
  return {
    path: pick('path', true),
    query: pick('query', false),
    headers: pick('header', false),
    body: sample?.body?.text ?? null,
    contentType: sample?.body?.contentType ?? null,
  }
}
const draft = reactive<TryDraft>(initialDraft())

const filled = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''))
const inputs = computed<SampleInputs>(() => ({
  serverUrl: serverUrl.value,
  path: filled(draft.path),
  query: filled(draft.query),
  headers: filled(draft.headers),
  body: draft.body,
  contentType: draft.contentType,
}))
const request = computed(() => sampleRequestFor(props.document, props.operation, inputs.value))
const samples = computed(() => codeSamplesFor(props.document, props.operation, inputs.value))

const open = ref(false)
</script>

<template>
  <section v-if="request" class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <h4 class="font-display text-base font-semibold tracking-[-0.015em] text-muted-foreground">{{ t('apiSamples.title') }}</h4>
      <Button
        variant="outline"
        size="sm"
        :aria-expanded="open"
        :aria-controls="open ? `${uid}-console` : undefined"
        @click="open = !open"
      >
        <X v-if="open" />
        <Play v-else />
        {{ open ? t('apiTry.close') : t('apiTry.open') }}
      </Button>
    </div>
    <ApiCodeSamples :samples="samples" />
    <div v-if="open" :id="`${uid}-console`" class="border-t pt-5">
      <ApiTryConsole
        :document="document"
        :operation="operation"
        :view="view"
        :draft="draft"
        :env="env"
        :request="request"
        :server-url="serverUrl"
        :workspace-id="workspaceId"
      />
    </div>
  </section>
</template>
