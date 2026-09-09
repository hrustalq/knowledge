<script setup lang="ts">
/**
 * The hand-off: this documentation, on the clipboard, shaped for an agent.
 *
 * Both bundles are built on demand rather than at module load — they are a few
 * hundred kilobytes of concatenated markdown, and nobody who never presses the
 * button should pay for them.
 *
 * The preview is deliberately the *head* of the skill rather than all of it: it
 * exists to show that the frontmatter is right and the content is what you
 * expected, and rendering a whole reference nobody asked to read would bury the
 * two buttons that are the point of the page.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { Check, Copy, X } from 'lucide-vue-next'
import { buildBundle, buildSkill, endpoints, mcpTools } from '@/pages/docs/bundle'
import { articles } from '@/pages/docs/registry'
import { Button } from '@/components/ui/button'
import { useCopy } from '@/lib/use-copy'

const { t } = useI18n()

const skill = useCopy()
const bundle = useCopy()

const PREVIEW_LINES = 24
const expanded = ref(false)

const skillText = computed(() => buildSkill())
const preview = computed(() => {
  const lines = skillText.value.split('\n')
  return expanded.value ? skillText.value : lines.slice(0, PREVIEW_LINES).join('\n')
})

/** Rough, and labelled as rough — an exact byte count answers no question here. */
function sizeOf(text: string): string {
  return `${Math.round(text.length / 1024)} KB`
}

const counts = computed(() => ({
  articles: articles.filter((a) => a.widget !== 'agent-skill').length,
  endpoints: endpoints.length,
  tools: mcpTools.length,
}))
</script>

<template>
  <div class="not-prose my-6 space-y-4">
    <div class="grid gap-3 sm:grid-cols-2">
      <!-- Primary: the shaped skill. Listed first and given the solid button,
           because the full bundle is the fallback for a different need. -->
      <div class="flex flex-col rounded-lg border p-4">
        <h3 class="font-display text-sm font-semibold">{{ t('docs.copySkillTitle') }}</h3>
        <p class="mt-1 flex-1 text-xs text-muted-foreground">
          {{ t('docs.copySkillHint', { endpoints: counts.endpoints, tools: counts.tools }) }}
        </p>
        <Button class="mt-3 w-full gap-2" @click="skill.copy(skillText)">
          <Check v-if="skill.state.value === 'copied'" class="size-4" />
          <X v-else-if="skill.state.value === 'failed'" class="size-4" />
          <Copy v-else class="size-4" />
          {{
            skill.state.value === 'copied'
              ? t('docs.copied')
              : skill.state.value === 'failed'
                ? t('docs.copyFailed')
                : t('docs.copySkill')
          }}
        </Button>
        <p class="mt-1.5 text-center text-[11px] text-muted-foreground">~{{ sizeOf(skillText) }}</p>
      </div>

      <div class="flex flex-col rounded-lg border p-4">
        <h3 class="font-display text-sm font-semibold">{{ t('docs.copyBundleTitle') }}</h3>
        <p class="mt-1 flex-1 text-xs text-muted-foreground">
          {{ t('docs.copyBundleHint', { n: counts.articles }) }}
        </p>
        <Button variant="outline" class="mt-3 w-full gap-2" @click="bundle.copy(buildBundle())">
          <Check v-if="bundle.state.value === 'copied'" class="size-4" />
          <X v-else-if="bundle.state.value === 'failed'" class="size-4" />
          <Copy v-else class="size-4" />
          {{
            bundle.state.value === 'copied'
              ? t('docs.copied')
              : bundle.state.value === 'failed'
                ? t('docs.copyFailed')
                : t('docs.copyBundle')
          }}
        </Button>
      </div>
    </div>

    <p
      v-if="skill.state.value === 'failed' || bundle.state.value === 'failed'"
      class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
    >
      {{ t('docs.copyFailedHint') }}
    </p>

    <div class="overflow-hidden rounded-lg border">
      <div class="flex items-center justify-between border-b bg-muted/50 px-3 py-1.5">
        <span class="font-mono text-[11px] text-muted-foreground">SKILL.md</span>
        <button type="button" class="text-[11px] text-muted-foreground hover:text-foreground" @click="expanded = !expanded">
          {{ expanded ? t('docs.showLess') : t('docs.showAll') }}
        </button>
      </div>
      <pre class="max-h-96 overflow-auto px-3 py-2 text-[11px] leading-relaxed"><code>{{ preview }}</code></pre>
    </div>
  </div>
</template>
