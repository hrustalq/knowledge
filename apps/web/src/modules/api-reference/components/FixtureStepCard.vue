<script setup lang="ts">
/**
 * One step of a test fixture in the editor (#483). A call step picks its
 * operation from the specs the author can open — never a typed key — then
 * takes the expected status, the request's path / query / header rows, a JSON
 * body and the captures later steps read. A manual step is a note about state
 * no API creates. Issues the server returned for this step sit at its foot.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, ArrowUp, Link2, Trash2 } from 'lucide-vue-next'
import type { FixtureIssueInfo } from '@knowledge/contracts'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Textarea } from '@/shared/ui/textarea'
import { pathParams, type StepDraft } from '@/modules/api-reference/model/test-fixture'
import ApiEndpoint from './ApiEndpoint.vue'
import ApiOperationPicker, { type PickedOperation } from './ApiOperationPicker.vue'
import FixtureRows from './FixtureRows.vue'

const step = defineModel<StepDraft>({ required: true })
const props = defineProps<{
  workspaceId: string
  number: number
  /** Operations already known by key: picked here, or resolved by the server. */
  operation: { method: string | null; path: string; specTitle: string } | null
  issues: FixtureIssueInfo[]
  first: boolean
  last: boolean
  bodyInvalid: boolean
}>()
const emit = defineEmits<{ pick: [op: PickedOperation]; move: [by: -1 | 1]; remove: [] }>()
const { t } = useI18n()
const uid = computed(() => `fx-${props.number}-${step.value.id}`)

function pick(op: PickedOperation) {
  if (step.value.kind !== 'call') return
  step.value.call = op.entityKey
  // Prefill a row per path parameter the author has not named yet.
  const named = new Set(step.value.path.map((r) => r.name))
  step.value.path = [...step.value.path, ...pathParams(op.path).filter((p) => !named.has(p)).map((name) => ({ name, value: '' }))]
  emit('pick', op)
}
</script>

<template>
  <li
    class="bg-card min-w-0 space-y-4 rounded-lg border p-4"
    :class="issues.length || bodyInvalid ? 'border-destructive/40' : ''"
    :aria-labelledby="`${uid}-heading`"
  >
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <span :id="`${uid}-heading`" class="text-muted-foreground text-caption font-mono tabular-nums">
        {{ number }}
        <span class="sr-only">{{ step.kind === 'manual' ? t('testFixture.manualStep') : t('testFixture.callStep') }}</span>
      </span>
      <Input
        v-model="step.id"
        :aria-label="t('testFixture.stepId')"
        spellcheck="false"
        autocapitalize="off"
        class="h-8 w-40 min-w-0 font-mono text-ui"
      />
      <span v-if="step.kind === 'manual'" class="text-muted-foreground text-caption">{{ t('testFixture.manualStep') }}</span>
      <span class="ml-auto flex items-center gap-0.5">
        <Button type="button" variant="ghost" size="icon" class="size-8" :disabled="first" :aria-label="t('testFixture.moveUp')" @click="emit('move', -1)">
          <ArrowUp class="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon" class="size-8" :disabled="last" :aria-label="t('testFixture.moveDown')" @click="emit('move', 1)">
          <ArrowDown class="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="text-muted-foreground hover:text-destructive size-8"
          :aria-label="t('testFixture.removeStep', { id: step.id })"
          @click="emit('remove')"
        >
          <Trash2 class="size-3.5" />
        </Button>
      </span>
    </div>

    <template v-if="step.kind === 'call'">
      <div class="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
        <div class="min-w-0 space-y-1.5">
          <span class="text-caption text-muted-foreground block font-medium">{{ t('testFixture.operation') }}</span>
          <ApiOperationPicker :workspace-id="workspaceId" protocol="http" @pick="pick">
            <template #trigger="{ toggle }">
              <button
                type="button"
                class="hover:bg-accent focus-visible:ring-ring/50 flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md border px-3 py-1.5 text-left outline-none focus-visible:ring-[3px]"
                :aria-label="step.call ? t('testFixture.changeOperation', { call: step.call }) : t('testFixture.pickOperation')"
                @click="toggle"
              >
                <ApiEndpoint v-if="operation" :method="operation.method" :path="operation.path" protocol="http" class="flex-1" />
                <code v-else-if="step.call" class="text-ui min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">{{ step.call }}</code>
                <span v-else class="text-muted-foreground text-ui flex-1">{{ t('testFixture.pickOperation') }}</span>
                <span v-if="operation" class="text-muted-foreground text-caption hidden shrink-0 truncate sm:inline">{{ operation.specTitle }}</span>
                <Link2 class="text-muted-foreground size-3.5 shrink-0" />
              </button>
            </template>
          </ApiOperationPicker>
        </div>
        <div class="space-y-1.5">
          <Label :for="`${uid}-expect`" class="text-caption text-muted-foreground font-medium">{{ t('testFixture.expect') }}</Label>
          <Input :id="`${uid}-expect`" v-model="step.expect" inputmode="numeric" :placeholder="t('testFixture.any2xx')" class="h-9 font-mono tabular-nums" />
        </div>
      </div>

      <div class="grid min-w-0 gap-4 lg:grid-cols-2">
        <FixtureRows
          v-model="step.path"
          mono
          :legend="t('testFixture.path')"
          :name-placeholder="t('testFixture.paramName')"
          value-placeholder="{{invoiceId}}"
          :add-label="t('testFixture.addParam')"
        />
        <FixtureRows
          v-model="step.query"
          mono
          :legend="t('testFixture.query')"
          :name-placeholder="t('testFixture.paramName')"
          :value-placeholder="t('testFixture.valuePlaceholder')"
          :add-label="t('testFixture.addParam')"
        />
        <FixtureRows
          v-model="step.headers"
          mono
          :legend="t('testFixture.headers')"
          name-placeholder="Authorization"
          value-placeholder="Bearer {{secret.token}}"
          :add-label="t('testFixture.addHeader')"
        />
        <FixtureRows
          v-model="step.capture"
          mono
          :legend="t('testFixture.capture')"
          name-placeholder="invoiceId"
          value-placeholder="$.id · header:Location"
          :add-label="t('testFixture.addCapture')"
        />
      </div>

      <div class="space-y-1.5">
        <Label :for="`${uid}-body`" class="text-caption text-muted-foreground font-medium">{{ t('testFixture.body') }}</Label>
        <Textarea
          :id="`${uid}-body`"
          v-model="step.body"
          spellcheck="false"
          autocapitalize="off"
          :placeholder="t('testFixture.bodyPlaceholder')"
          :aria-invalid="bodyInvalid || undefined"
          :aria-describedby="bodyInvalid ? `${uid}-body-error` : undefined"
          class="min-h-20 resize-y font-mono text-ui leading-relaxed [tab-size:2]"
        />
        <p v-if="bodyInvalid" :id="`${uid}-body-error`" class="text-destructive text-caption">{{ t('testFixture.bodyInvalid') }}</p>
      </div>
    </template>

    <div v-else class="space-y-1.5">
      <Label :for="`${uid}-manual`" class="sr-only">{{ t('testFixture.manualStep') }}</Label>
      <Textarea
        :id="`${uid}-manual`"
        v-model="step.manual"
        :placeholder="t('testFixture.manualPlaceholder')"
        class="min-h-16 resize-y text-ui"
      />
    </div>

    <ul v-if="issues.length" role="alert" class="text-destructive space-y-1 text-caption">
      <li v-for="(i, n) in issues" :key="n" class="flex flex-wrap gap-x-2">
        <code class="text-muted-foreground font-mono">{{ i.path }}</code><span>{{ i.message }}</span>
      </li>
    </ul>
  </li>
</template>
