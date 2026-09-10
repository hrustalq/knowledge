<script setup lang="ts">
// Web access and source policy (docs/features/25).
//
// It lives inside the Plugins panel rather than in an eighth tab, and on the
// merits: this panel is already the roster of external things the model can
// reach, and a plugin URL and a fetch target are the same question asked twice.
//
// The mode radio leads, because the list means nothing without it. The same
// rows are an allowlist under one mode and a blocklist under the other, so a
// list shown above its mode would be a list of domains with no stated effect.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Check, Globe, Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-vue-next'
import type {
  CheckSourcePolicyResponse,
  ListSourcePoliciesResponse,
  SourcePolicy,
  WebAccessMode,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

const { t } = useI18n()

const props = defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()
const queryClient = useQueryClient()

const query = useQuery(apiQueryOptions('/v1/ai/source-policies', { query: { workspaceId } }))
const data = computed(() => query.data.value as ListSourcePoliciesResponse | undefined)
const access = computed(() => data.value?.webAccess)

/**
 * Longest pattern first — the order the server decides in. Alphabetical would
 * be tidier and would hide the one rule that governs the whole table: when two
 * rows both cover a host, the more specific one wins.
 */
const policies = computed(() =>
  [...(data.value?.policies ?? [])].sort((a, b) => b.pattern.length - a.pattern.length || a.pattern.localeCompare(b.pattern)),
)

/** The broader row this one refines, when there is one — the precedence made visible. */
function refines(policy: SourcePolicy): SourcePolicy | undefined {
  return policies.value.find((other) => other.id !== policy.id && policy.pattern.endsWith(`.${other.pattern}`))
}

const MODES: WebAccessMode[] = ['off', 'allowlist', 'open']

const invalidates = () => [['/v1/ai/source-policies'], ['/v1/ai/settings']]
const updateSettings = useApiMutation('patch', '/v1/ai/settings', { invalidates })
const createPolicy = useApiMutation('post', '/v1/ai/source-policies', { invalidates })
const deletePolicy = useApiMutation('delete', '/v1/ai/source-policies/{id}', { invalidates })

async function setMode(mode: WebAccessMode) {
  if (mode === access.value?.requested) return
  try {
    await updateSettings.mutateAsync({ body: { workspaceId, webAccessMode: mode } })
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// ---- The list ---------------------------------------------------------------

const pattern = ref('')
const allow = ref(true)

async function add() {
  const value = pattern.value.trim()
  if (!value) return
  try {
    await createPolicy.mutateAsync({ body: { workspaceId, pattern: value, allow: allow.value } })
    pattern.value = ''
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function remove(policy: SourcePolicy) {
  try {
    await deletePolicy.mutateAsync({ path: { id: policy.id } })
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function flip(policy: SourcePolicy) {
  try {
    await api.patch('/v1/ai/source-policies/{id}', { path: { id: policy.id }, body: { allow: !policy.allow } })
    await queryClient.invalidateQueries({ queryKey: ['/v1/ai/source-policies'] })
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// ---- Dry run ----------------------------------------------------------------
//
// A policy list's only observable effect is a tool call failing inside somebody
// else's chat. This is the one place the rules can be asked a question and
// answer with the row that decided it.

const probe = ref('')
const probing = ref(false)
const verdict = ref<CheckSourcePolicyResponse | null>(null)

async function check() {
  const url = probe.value.trim()
  if (!url) return
  probing.value = true
  verdict.value = null
  try {
    verdict.value = (await api.post('/v1/ai/source-policies/check', {
      body: { workspaceId, url },
    })) as CheckSourcePolicyResponse
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    probing.value = false
  }
}
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
      <div>
        <h3 class="flex items-center gap-2 text-sm font-semibold">
          <Globe class="size-4 text-muted-foreground" />
          {{ t('ai.web.title') }}
        </h3>
        <p class="mt-0.5 text-sm text-muted-foreground">{{ t('ai.web.subtitle') }}</p>
      </div>
      <Badge v-if="access && !access.searchConfigured && access.effective !== 'off'" variant="outline">
        {{ t('ai.web.searchUnconfigured') }}
      </Badge>
    </header>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton class="h-32 w-full" />
      <Skeleton class="h-20 w-full" />
    </div>

    <template v-else-if="access">
      <!-- The mode. Three options whose consequences differ enough that a
           <select> would hide the decision behind a click. -->
      <RadioGroup
        :model-value="access.requested ?? access.ceiling"
        :disabled="!canManage"
        class="kn-modes"
        :aria-label="t('ai.web.title')"
        @update:model-value="setMode($event as WebAccessMode)"
      >
        <!-- Two different facts, two different marks. The radio dot follows what
             this workspace ASKS for; the tint and the badge follow what is
             actually IN FORCE. They are the same row in every case but a clamp,
             and when a clamp splits them, marking only the selection would
             leave the mode that is really running invisible — which is the one
             thing this section exists to show. -->
        <label
          v-for="mode in MODES"
          :key="mode"
          class="kn-mode"
          :data-active="access.effective === mode || undefined"
          :data-capped="access.source === 'clamped' && access.requested === mode || undefined"
        >
          <RadioGroupItem :value="mode" :disabled="!canManage" class="mt-0.5" />
          <span class="min-w-0">
            <span class="flex flex-wrap items-center gap-1.5">
              <span class="text-sm font-medium">{{ t(`ai.web.mode.${mode}.label`) }}</span>
              <!-- A mode the deployment will narrow stays selectable: the row
                   records what this workspace wants, and it survives the
                   ceiling being raised later. What it must not do is imply it
                   is in force. -->
              <Badge
                v-if="access.source === 'clamped' && mode === access.requested"
                variant="secondary"
                class="font-normal"
              >
                {{ t('ai.web.cappedTo', { mode: t(`ai.web.mode.${access.effective}.label`) }) }}
              </Badge>
              <Badge
                v-else-if="access.source === 'clamped' && mode === access.effective"
                class="font-normal"
              >
                {{ t('ai.web.inForce') }}
              </Badge>
              <Badge v-else-if="access.requested === null && mode === access.ceiling" variant="outline" class="font-normal">
                {{ t('ai.web.fromEnv') }}
              </Badge>
            </span>
            <span class="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
              {{ t(`ai.web.mode.${mode}.body`) }}
            </span>
          </span>
        </label>
      </RadioGroup>

      <!-- A silent clamp is a lie about what the workspace is configured to do,
           so the clamp gets a sentence, not just a badge. -->
      <p v-if="access.source === 'clamped'" class="kn-clamp">
        <ShieldCheck class="mt-px size-3.5 shrink-0" />
        <span>
          {{
            t('ai.web.clampExplained', {
              requested: t(`ai.web.mode.${access.requested}.label`),
              ceiling: t(`ai.web.mode.${access.ceiling}.label`),
            })
          }}
        </span>
      </p>

      <!-- The list. Hidden under `off`, where it governs nothing: showing rows
           that cannot fire would be a table of rules the reader has to work out
           are inert. -->
      <template v-if="access.effective !== 'off'">
        <div class="space-y-2">
          <p class="text-xs font-medium text-muted-foreground">
            {{ t(access.effective === 'allowlist' ? 'ai.web.listAllowlist' : 'ai.web.listOpen') }}
          </p>

          <ul v-if="policies.length" class="divide-y rounded-lg border">
            <li v-for="policy in policies" :key="policy.id" class="flex items-center gap-3 px-3 py-2">
              <span class="min-w-0 flex-1">
                <span class="font-mono text-sm">{{ policy.pattern }}</span>
                <span v-if="refines(policy)" class="ml-2 text-[11px] text-muted-foreground">
                  {{ t('ai.web.refines', { pattern: refines(policy)!.pattern }) }}
                </span>
                <span v-if="policy.note" class="block truncate text-xs text-muted-foreground">{{ policy.note }}</span>
              </span>

              <!-- The row's state and the way to change it are one control.
                   A state icon beside a button labelled with the opposite verb
                   put “denied” and the word “Allow” on the same line, and
                   nothing on that line said which one was the current fact. -->
              <div v-if="canManage" class="kn-seg shrink-0" role="group" :aria-label="policy.pattern">
                <button
                  type="button"
                  data-effect="allow"
                  :data-on="policy.allow || undefined"
                  :aria-pressed="policy.allow"
                  @click="policy.allow || flip(policy)"
                >
                  {{ t('ai.web.allowed') }}
                </button>
                <button
                  type="button"
                  data-effect="deny"
                  :data-on="!policy.allow || undefined"
                  :aria-pressed="!policy.allow"
                  @click="policy.allow && flip(policy)"
                >
                  {{ t('ai.web.denied') }}
                </button>
              </div>
              <Badge v-else :variant="policy.allow ? 'secondary' : 'destructive'" class="shrink-0 font-normal">
                {{ t(policy.allow ? 'ai.web.allowed' : 'ai.web.denied') }}
              </Badge>

              <Button
                v-if="canManage"
                variant="ghost"
                size="icon-sm"
                class="shrink-0 text-muted-foreground"
                :aria-label="t('ai.web.removePattern', { pattern: policy.pattern })"
                @click="remove(policy)"
              >
                <Trash2 class="size-3.5" />
              </Button>
            </li>
          </ul>

          <!-- Allowlist mode with nothing allowed is a search that finds pages
               and can read none of them. The API refuses to save it; here it is
               named before someone hits that. -->
          <p
            v-else
            class="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground"
            :class="access.effective === 'allowlist' && 'kn-refuse-ink border-destructive/50'"
          >
            {{ t(access.effective === 'allowlist' ? 'ai.web.emptyAllowlist' : 'ai.web.emptyOpen') }}
          </p>

          <!-- Labelled, like the dry run below it. Unlabelled, the two were a
               pair of full-width inputs a few pixels apart, and the pattern
               hint under this one read as the caption of the one below —
               typing a URL into the wrong box adds a rule instead of asking a
               question, which is a mistake with a consequence. -->
          <p v-if="canManage" class="pt-1 text-xs font-medium text-muted-foreground">{{ t('ai.web.addLabel') }}</p>
          <form v-if="canManage" class="flex flex-wrap items-center gap-2" @submit.prevent="add">
            <Input
              v-model="pattern"
              class="h-8 min-w-0 flex-1 font-mono text-sm"
              placeholder="docs.example.com"
              :aria-label="t('ai.web.patternLabel')"
            />
            <div class="kn-seg" role="group" :aria-label="t('ai.web.effectLabel')">
              <button type="button" :data-on="allow || undefined" @click="allow = true">
                {{ t('ai.web.allowed') }}
              </button>
              <button type="button" :data-on="!allow || undefined" @click="allow = false">
                {{ t('ai.web.denied') }}
              </button>
            </div>
            <Button type="submit" size="sm" variant="outline" :disabled="!pattern.trim() || createPolicy.isPending.value">
              <Plus class="size-3.5" /> {{ t('common.add') }}
            </Button>
          </form>
          <p class="text-[11px] leading-relaxed text-muted-foreground">{{ t('ai.web.patternHint') }}</p>
        </div>

        <!-- Dry run. Named, because otherwise it is a third full-width input
             stacked under two others and nothing distinguishes asking a
             question from adding a rule. -->
        <div class="rounded-lg border bg-muted/30 p-3">
          <p class="mb-2 text-xs font-medium text-muted-foreground">{{ t('ai.web.tryHint') }}</p>
          <form class="flex flex-wrap items-center gap-2" @submit.prevent="check">
            <Input
              v-model="probe"
              class="h-8 min-w-0 flex-1 text-sm"
              placeholder="https://docs.example.com/guide"
              :aria-label="t('ai.web.tryLabel')"
            />
            <Button type="submit" size="sm" variant="outline" :disabled="!probe.trim() || probing">
              <Loader2 v-if="probing" class="size-3.5 animate-spin" />
              {{ t('ai.web.try') }}
            </Button>
          </form>
          <p v-if="verdict" class="kn-verdict" :data-allowed="verdict.allowed || undefined">
            <component :is="verdict.allowed ? Check : X" class="mt-px size-3.5 shrink-0" />
            <span class="min-w-0">
              {{
                verdict.allowed
                  ? t('ai.web.verdictAllowed', { host: verdict.host })
                  : t(`ai.web.verdict.${verdict.reason}`, { host: verdict.host })
              }}
              <!-- Which rule decided is its own line: appended to the verdict it
                   produced "…refused. — decided by example.com.", a dash after
                   a full stop. -->
              <span class="kn-verdict-by">
                {{
                  verdict.matchedPattern
                    ? t('ai.web.verdictBy', { pattern: verdict.matchedPattern })
                    : t('ai.web.verdictByMode')
                }}
              </span>
            </span>
          </p>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.kn-modes {
  gap: 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
}

/* One control, three stacked rows sharing a border — not three cards. The
   options are alternatives to each other, and floating them apart would make
   them read as three separate settings. */
.kn-mode {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.75rem;
  cursor: pointer;
  transition: background-color 120ms ease-out;
}
.kn-mode + .kn-mode {
  border-top: 1px solid var(--border);
}
.kn-mode:hover {
  background: var(--accent);
}
.kn-mode[data-active] {
  background: color-mix(in oklab, var(--primary) 6%, transparent);
}
/* Selected but not in force: the tint that means "this is what is happening"
   is withdrawn, and the badge beside it says why. */
.kn-mode[data-capped] {
  background: color-mix(in oklab, var(--muted-foreground) 6%, transparent);
}

/*
 * `--destructive` is a FILL colour: oklch L≈0.40, which is a dark red. Used as
 * text on the dark theme's near-black panel it measures 1.87:1 — unreadable,
 * and the fact that it "looks red" is exactly what hides that. Mixed toward the
 * foreground it keeps the hue, gains the lightness, and inverts correctly in
 * the light theme without a second rule.
 */
.kn-refuse-ink {
  color: color-mix(in oklab, var(--destructive) 45%, var(--foreground));
}

.kn-clamp,
.kn-verdict {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.5;
}
.kn-clamp {
  background: color-mix(in oklab, var(--muted-foreground) 8%, transparent);
  color: var(--muted-foreground);
}
/*
 * The sentence is always foreground-strength; the panel tint and the icon
 * carry which verdict it is. A refusal spelled out in red-on-dark was the
 * version that failed to be readable at exactly the moment it mattered most.
 */
.kn-verdict {
  margin-top: 0.5rem;
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
  color: var(--foreground);
}
.kn-verdict[data-allowed] {
  background: color-mix(in oklab, var(--primary) 8%, transparent);
}
.kn-verdict > svg {
  color: color-mix(in oklab, var(--destructive) 45%, var(--foreground));
}
.kn-verdict[data-allowed] > svg {
  color: var(--primary);
}
.kn-verdict-by {
  display: block;
  margin-top: 0.125rem;
  opacity: 0.85;
  font-size: 0.75rem;
}

/* Two-state switch for the row being added. A checkbox labelled "allow" would
   be read as "add this", which is what the button beside it does. */
.kn-seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  overflow: hidden;
}
.kn-seg button {
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
  color: var(--muted-foreground);
  transition: background-color 120ms ease-out, color 120ms ease-out;
}
.kn-seg button:hover {
  background: var(--accent);
}
.kn-seg button[data-on][data-effect='allow'],
.kn-seg button[data-on]:not([data-effect]) {
  background: var(--primary);
  color: var(--primary-foreground);
}
/* Deny is destructive, not another shade of the accent: in a list read top to
   bottom, the refusals have to be the thing that catches the eye. */
.kn-seg button[data-on][data-effect='deny'] {
  background: var(--destructive);
  color: #fff;
}
.kn-seg button:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
</style>
