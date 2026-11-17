<script setup lang="ts">
/**
 * The wizard's "which tool" question (#1225) as tiles: the tool's name, what
 * kind of tool it is, what this platform installs into it, and its mark set
 * large and cropped by the corner. Paper and ink like the rest of the app — the
 * mark is drawn in `currentColor`, and only the picked tile takes the indigo
 * that marks a selection. A native radio underneath carries keyboard and
 * screen-reader behaviour.
 */
import { useI18n } from 'vue-i18n'
import { Cable, CircleCheck, Feather, Pi, SquareTerminal } from 'lucide-vue-next'
import { clientMark, type McpClientGuide } from '@/entities/access'

defineProps<{ clients: McpClientGuide[]; legend: string }>()
const model = defineModel<string | null>({ required: true })
const { t } = useI18n()

const KIND: Record<string, 'cli' | 'editor' | 'desktop' | 'harness' | 'any'> = {
  'claude-code': 'cli',
  codex: 'cli',
  gemini: 'cli',
  qwen: 'cli',
  kimi: 'cli',
  pi: 'cli',
  omp: 'cli',
  opencode: 'cli',
  deepseek: 'harness',
  hermes: 'harness',
  cursor: 'editor',
  vscode: 'editor',
  windsurf: 'editor',
  zed: 'editor',
  'claude-desktop': 'desktop',
  http: 'any',
}

/** A client simple-icons has no mark for draws a lucide icon in the same slot. */
const FALLBACK = { codex: SquareTerminal, pi: Pi, omp: Pi, hermes: Feather } as const
const fallback = (id: string) => FALLBACK[id as keyof typeof FALLBACK] ?? Cable

function facts(c: McpClientGuide): string {
  return [
    c.command && t('connect.wizard.client.facts.command'),
    c.skillDir && t('connect.wizard.client.facts.skill'),
    c.captureKit && t('connect.wizard.client.facts.kit'),
  ]
    .filter(Boolean)
    .join(' · ')
}
</script>

<template>
  <!-- A container: the question column's width, not the viewport's, decides how many tiles fit. -->
  <fieldset class="@container min-w-0">
    <legend class="sr-only">{{ legend }}</legend>
    <div class="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
      <label
        v-for="c in clients"
        :key="c.id"
        class="kn-tile group relative isolate flex min-h-36 cursor-pointer flex-col overflow-hidden rounded-xl border bg-card p-5 transition-colors"
        :class="model === c.id ? 'border-primary/60 bg-primary/5' : 'hover:border-foreground/20'"
      >
        <input v-model="model" type="radio" name="kn-wiz-client" :value="c.id" class="sr-only" />
        <span class="pr-8 font-display text-lg leading-tight font-semibold tracking-tight wrap-anywhere">{{ c.name }}</span>
        <span class="mt-1 text-xs text-muted-foreground">{{ t(`connect.wizard.client.kinds.${KIND[c.id] ?? 'any'}`) }}</span>
        <span class="mt-auto max-w-[70%] pt-4 text-caption text-muted-foreground">{{ facts(c) }}</span>

        <CircleCheck v-if="model === c.id" class="absolute top-4 right-4 size-5 text-primary" aria-hidden="true" />

        <!-- The mark: large, cropped by the corner, behind the text. -->
        <svg
          v-if="clientMark(c.id)"
          viewBox="0 0 24 24"
          class="kn-mark absolute -right-3 -bottom-4 -z-10 size-24"
          :class="model === c.id ? 'text-foreground/80' : 'text-foreground/15 group-hover:text-foreground/30'"
          aria-hidden="true"
        >
          <path fill="currentColor" :d="clientMark(c.id)!" />
        </svg>
        <component
          :is="fallback(c.id)"
          v-else
          class="kn-mark absolute -right-3 -bottom-4 -z-10 size-24 stroke-[1.25]"
          :class="model === c.id ? 'text-foreground/80' : 'text-foreground/15 group-hover:text-foreground/30'"
          aria-hidden="true"
        />
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
.kn-tile:has(input:focus-visible) {
  box-shadow: 0 0 0 3px var(--ring);
  border-color: var(--ring);
}
.kn-mark {
  transition:
    color 200ms ease-out,
    transform 260ms cubic-bezier(0.16, 1, 0.3, 1);
}
.kn-tile:hover .kn-mark {
  transform: translate(-4px, -4px) rotate(-4deg);
}
@media (prefers-reduced-motion: reduce) {
  .kn-mark {
    transition: color 120ms linear;
  }
  .kn-tile:hover .kn-mark {
    transform: none;
  }
}
</style>
