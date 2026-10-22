<script setup lang="ts">
// Recipes (#70): a ready-made schedule and/or trigger for an existing agent,
// applied in one press. Everything a recipe writes starts off, so applying
// one never starts a run — the admin turns it on in the agent's own editor,
// which this dialog opens next, and becomes the owner its runs execute as.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { CalendarClock, Zap } from 'lucide-vue-next'
import {
  AGENT_RECIPE_KEYS,
  AGENT_RECIPES,
  type AgentRecipe,
  type AgentRecipeKey,
  type AiAgentSummary,
  type ApplyAgentRecipeResponse,
} from '@knowledge/contracts'
import { useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { formatCalendarPart, formatList } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps<{ agents: AiAgentSummary[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ applied: [agentKey: string] }>()
const { t } = useI18n()

const workspaceId = getWorkspaceId()
const apply = useApiMutation('post', '/v1/ai/agents/recipes/{recipe}/apply', {
  invalidates: () => [['/v1/ai/agents'], ['/v1/ai/agents/triggers']],
})
const pending = ref<AgentRecipeKey | null>(null)

/** camelCase message keys: vue-i18n reads a dot as a path, and a hyphen is fine but unidiomatic there. */
const MESSAGE: Record<AgentRecipeKey, string> = {
  'weekly-digest': 'weeklyDigest',
  'freshness-sweep': 'freshnessSweep',
  'glossary-suggester': 'glossarySuggester',
  'docs-from-tickets': 'docsFromTickets',
}

const recipes = computed(() =>
  AGENT_RECIPE_KEYS.map((key) => {
    const recipe = AGENT_RECIPES[key]
    return { recipe, agent: props.agents.find((a) => a.key === recipe.agentKey) ?? null }
  }),
)

/** "Mondays 09:00" in the reader's language, from the recipe's own spelling. 2026-10-11 is a Sunday. */
function scheduleText(recipe: AgentRecipe): string | null {
  const s = recipe.schedule
  if (!s) return null
  if (s.kind === 'daily') return t('ai.agents.dailyAt', { time: s.time })
  const days = (s.weekdays ?? []).map((day) => formatCalendarPart(`2026-10-${11 + day}`, 'weekday'))
  return t('ai.agents.weeklyAt', { days: formatList(days), time: s.time })
}

async function run(recipe: AgentRecipe) {
  pending.value = recipe.key
  try {
    const res = (await apply.mutateAsync({
      path: { recipe: recipe.key },
      body: {
        workspaceId,
        // The schedule is read in the zone of whoever set it up, as the
        // schedule editor pre-fills it.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
      },
    })) as ApplyAgentRecipeResponse
    const wrote = res.created.schedule || res.created.triggers > 0
    toast.success(
      wrote
        ? t('ai.recipes.applied', { name: res.agent.name })
        : t('ai.recipes.alreadyThere', { name: res.agent.name }),
    )
    open.value = false
    emit('applied', res.agent.key)
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    pending.value = null
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{{ t('ai.recipes.title') }}</DialogTitle>
        <DialogDescription>{{ t('ai.recipes.hint') }}</DialogDescription>
      </DialogHeader>

      <ul class="space-y-3">
        <li
          v-for="{ recipe, agent } in recipes"
          :key="recipe.key"
          class="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
        >
          <div class="min-w-0 flex-1 space-y-1">
            <p class="text-sm font-medium">{{ t(`ai.recipes.${MESSAGE[recipe.key]}.title`) }}</p>
            <p class="text-muted-foreground text-xs">{{ t(`ai.recipes.${MESSAGE[recipe.key]}.desc`) }}</p>
            <p class="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <span>{{ t('ai.recipes.agent', { name: agent?.name ?? recipe.agentKey }) }}</span>
              <span v-if="scheduleText(recipe)" class="inline-flex items-center gap-1">
                <CalendarClock class="size-3" /> {{ scheduleText(recipe) }}
              </span>
              <span v-if="recipe.trigger" class="inline-flex items-center gap-1">
                <Zap class="size-3" /> {{ t(`ai.triggers.events.${recipe.trigger.event}`) }}
              </span>
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            :disabled="!agent || pending !== null"
            @click="run(recipe)"
          >
            {{ pending === recipe.key ? t('ai.recipes.applying') : t('ai.recipes.apply') }}
          </Button>
        </li>
      </ul>
    </DialogContent>
  </Dialog>
</template>
