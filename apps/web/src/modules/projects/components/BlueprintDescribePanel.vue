<script setup lang="ts">
/**
 * Start → Describe it (#716, phase 5): the person says what the project is
 * for, optionally picks a blueprint to start from, and the `scaffolder`
 * drafts an outline (`POST /v1/blueprints/generate`). It may look at the
 * workspace's tree and search under the person's own access; nothing is
 * written until Create. The card is hidden when `assistant` is off, so this
 * panel never opens without it.
 *
 * Shape's anatomy, full bleed: the brief fills the main pane, the starting
 * points sit in the side pane with the picked one's outline beneath them.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, Check, FilePlus, Loader2, Sparkles } from 'lucide-vue-next'
import { blueprintText, type Blueprint, type BlueprintEntry, type Locale } from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/textarea'
import BlueprintTreePreview from '@/modules/projects/components/BlueprintTreePreview.vue'
import { cloneJson, countPages } from '@/modules/projects/model/blueprint-tree'
import type { ScaffoldOrigin } from '@/modules/projects/model/scaffold-machine'

const props = defineProps<{ entries: BlueprintEntry[]; locale: Locale; canEdit: boolean; initialBrief?: string }>()
const emit = defineEmits<{ back: []; pick: [blueprint: Blueprint, origin: ScaffoldOrigin] }>()

const { t } = useI18n()

/** The server's bounds (`GenerateBlueprintDto`). */
const BRIEF_MIN = 10
const BRIEF_MAX = 4000
const TIPS = ['covers', 'readers', 'grows', 'exists'] as const

const brief = ref(props.initialBrief ?? '')
/** A listed blueprint's key to adapt, or '' for nothing. */
const startKey = ref('')
const starts = computed(() => props.entries.filter((e) => e.blueprint.tree.length))
const start = computed(() => starts.value.find((e) => e.key === startKey.value) ?? null)

const drafting = ref(false)
const failure = ref<string | null>(null)
const ready = computed(() => props.canEdit && brief.value.trim().length >= BRIEF_MIN && !drafting.value)

const field = ref<InstanceType<typeof Textarea> | null>(null)
onMounted(() => (field.value?.$el as HTMLTextAreaElement | undefined)?.focus())

// Back while drafting leaves the panel: a late answer must not pull the wizard into Shape.
let left = false
onBeforeUnmount(() => (left = true))

async function draft() {
  if (!ready.value) return
  drafting.value = true
  failure.value = null
  const text = brief.value.trim()
  try {
    const res = await api.post('/v1/blueprints/generate', {
      body: {
        workspaceId: getWorkspaceId(),
        brief: text,
        // The DTO cannot name the contracts type; the server parses it with the one schema.
        ...(start.value ? { blueprint: cloneJson(start.value.blueprint) as unknown as Record<string, unknown> } : {}),
      },
    })
    if (!left) emit('pick', res.blueprint, { kind: 'described', brief: text })
  } catch (e) {
    if (!left) failure.value = errorMessage(e, t)
  } finally {
    drafting.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    void draft()
  }
}
</script>

<template>
  <div
    class="grid h-full min-h-0 content-start overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:content-stretch lg:overflow-hidden"
    :aria-busy="drafting || undefined"
  >
    <!-- The brief: the main pane, and the textarea takes whatever height it leaves. -->
    <!-- min-h-0 only side by side: stacked, each pane keeps its full height and the whole step scrolls. -->
    <form class="flex flex-col gap-4 px-4 py-4 lg:min-h-0 lg:px-6" @submit.prevent="draft">
      <div class="space-y-1">
        <Button variant="ghost" size="sm" class="text-muted-foreground -ml-2 gap-1.5" @click="emit('back')">
          <ArrowLeft class="size-4" /> {{ t('scaffold.derive.back') }}
        </Button>
        <h2 class="text-lg font-semibold">{{ t('scaffold.describe.title') }}</h2>
        <p class="kn-measure text-muted-foreground text-sm leading-relaxed">{{ t('scaffold.describe.body') }}</p>
      </div>

      <label class="flex min-h-0 flex-1 flex-col gap-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('scaffold.describe.label') }}</span>
        <Textarea
          ref="field"
          v-model="brief"
          class="kn-brief min-h-40 flex-1 resize-none text-sm leading-relaxed"
          :maxlength="BRIEF_MAX"
          :placeholder="t('scaffold.describe.placeholder')"
          :disabled="drafting || !canEdit"
          :aria-invalid="!!failure || undefined"
          aria-describedby="kn-describe-hint"
          @keydown="onKey"
        />
      </label>

      <p id="kn-describe-hint" class="text-muted-foreground kn-measure text-caption leading-snug">{{ t('scaffold.describe.hint') }}</p>
      <p v-if="failure" role="alert" class="text-destructive text-sm">{{ t('scaffold.describe.failed') }} {{ failure }}</p>

      <div class="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center">
        <p class="text-muted-foreground text-caption sm:mr-auto" aria-live="polite">
          <template v-if="drafting">{{ t('scaffold.describe.drafting') }}</template>
          <span v-else class="max-sm:hidden">{{ t('scaffold.describe.shortcut') }}</span>
        </p>
        <Button type="submit" class="gap-1.5" :disabled="!ready">
          <Loader2 v-if="drafting" class="size-4 animate-spin" />
          <Sparkles v-else class="size-4" />
          {{ t('scaffold.describe.submit') }}
        </Button>
      </div>
    </form>

    <!-- Where it starts from, and what that start already holds. -->
    <aside class="flex flex-col border-t lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l">
      <fieldset :disabled="drafting || !canEdit">
        <legend class="text-muted-foreground px-4 pt-4 pb-2 text-xs font-medium lg:px-6">{{ t('scaffold.describe.startFrom') }}</legend>
        <div class="divide-y border-y">
          <label class="kn-start-row">
            <input v-model="startKey" type="radio" name="kn-describe-start" value="" class="sr-only" />
            <span class="kn-start-icon"><FilePlus class="size-4" /></span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ t('scaffold.describe.nothing') }}</span>
              <span class="text-muted-foreground block truncate text-caption">{{ t('scaffold.describe.nothingMeta') }}</span>
            </span>
            <Check v-if="!startKey" class="text-primary size-4 shrink-0" aria-hidden="true" />
          </label>
          <label v-for="entry in starts" :key="entry.key" class="kn-start-row">
            <input v-model="startKey" type="radio" name="kn-describe-start" :value="entry.key" class="sr-only" />
            <span class="kn-start-icon" aria-hidden="true">{{ entry.blueprint.icon ?? '' }}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ blueprintText(entry.blueprint.name, locale) }}</span>
              <span class="text-muted-foreground block truncate text-caption tabular-nums">
                {{ t('scaffold.start.pages', { count: countPages(entry.blueprint.tree) }, countPages(entry.blueprint.tree)) }}
              </span>
            </span>
            <Check v-if="startKey === entry.key" class="text-primary size-4 shrink-0" aria-hidden="true" />
          </label>
        </div>
      </fieldset>

      <section class="px-4 py-4 lg:px-6" aria-live="polite">
        <template v-if="start">
          <h3 class="text-muted-foreground mb-2 text-xs font-medium">{{ t('scaffold.describe.adapts') }}</h3>
          <BlueprintTreePreview :tree="start.blueprint.tree" :locale="locale" :max="30" />
        </template>
        <template v-else>
          <h3 class="text-muted-foreground mb-2 text-xs font-medium">{{ t('scaffold.describe.tipsTitle') }}</h3>
          <ul class="text-muted-foreground space-y-2 text-ui leading-snug">
            <li v-for="tip in TIPS" :key="tip" class="flex gap-2">
              <span class="bg-border mt-[0.45em] size-1.5 shrink-0 rounded-full" aria-hidden="true" />
              {{ t(`scaffold.describe.tips.${tip}`) }}
            </li>
          </ul>
        </template>
      </section>
    </aside>
  </div>
</template>

<style scoped>
/* The shared Textarea grows with its content; here it fills the pane instead. */
.kn-brief {
  field-sizing: fixed;
}
.kn-start-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 1rem;
  cursor: pointer;
  transition: background-color 120ms;
}
@media (min-width: 64rem) {
  .kn-start-row {
    padding-inline: 1.5rem;
  }
}
.kn-start-row:hover {
  background: var(--accent);
}
.kn-start-row:has(:checked) {
  background: color-mix(in oklab, var(--primary) 8%, transparent);
}
.kn-start-row:has(:focus-visible) {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
fieldset:disabled .kn-start-row {
  cursor: not-allowed;
  opacity: 0.55;
}
.kn-start-icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 0.5rem;
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: 1rem;
}
@media (prefers-reduced-motion: reduce) {
  .kn-start-row {
    transition-duration: 0.01ms;
  }
}
</style>
