<script setup lang="ts">
/**
 * An operation's request (#78): its code samples, and the try-it console that
 * edits them. One draft feeds both, so the sample on screen is the request the
 * console sends — less the credentials, which a sample never carries.
 *
 * The console mounts only when asked for, and opens above the samples in
 * place (Collapse), the way Swagger's "Try it out" turns a card live. A spec
 * of 300 operations renders 300 samples, not 300 forms, and the server render
 * never contains a field. The draft lives here, so closing the console and
 * opening it again finds the values where they were left.
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
import { Collapse } from '@/components/ui/collapse'
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
const example = initialDraft()
const draft = reactive<TryDraft>({ ...example, path: { ...example.path }, query: { ...example.query }, headers: { ...example.headers } })

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
  <section v-if="request">
    <h4 class="kn-op-section-title">
      {{ t('apiSamples.title') }}
      <Button
        :variant="open ? 'secondary' : 'outline'"
        size="sm"
        class="ml-auto h-7 font-sans text-[0.8rem]"
        :aria-expanded="open"
        :aria-controls="`${uid}-console`"
        @click="open = !open"
      >
        <X v-if="open" />
        <Play v-else />
        {{ open ? t('apiTry.close') : t('apiTry.open') }}
      </Button>
    </h4>
    <div class="kn-op-pad space-y-5">
      <Collapse :open="open">
        <div :id="`${uid}-console`" class="pb-1">
          <ApiTryConsole
            :document="document"
            :operation="operation"
            :view="view"
            :draft="draft"
            :example-body="example.body"
            :env="env"
            :request="request"
            :server-url="serverUrl"
            :workspace-id="workspaceId"
          />
        </div>
      </Collapse>
      <ApiCodeSamples :samples="samples" />
    </div>
  </section>
</template>
