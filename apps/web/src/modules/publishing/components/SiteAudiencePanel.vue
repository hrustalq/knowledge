<script setup lang="ts">
/**
 * The Audience tab of a site's settings (issue #77 phase 3, docs/features/44):
 * which pages are kept from the public, and visitor sign-in.
 *
 * A rule is per site, not per version, and the API restamps every version
 * before it answers, so there is no "rebuild to apply". Claims are typed one
 * per line as `name=value, value`, the shape a person writes in a note, and
 * checked here only for that shape; the API is the validator.
 *
 * The visitor secret is shown once, in this component's memory, right after
 * it is made; leaving the tab forgets it, as it should. Replacing or clearing
 * it signs every visitor out, so both ask a second time, inline beside the
 * secret they act on — the same inline step as deleting the site
 * (SiteSettingsPage). A yes/no that has nothing beside it to point at goes
 * through `confirm()` (components/ui/confirm) instead; nothing here uses a
 * browser confirm().
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Check, Copy, Pencil, Trash2 } from 'lucide-vue-next'
import {
  SITE_AUDIENCE_RULE_KINDS,
  SITE_VISITOR_TOKEN_PARAM,
  type PublishedSiteSummary,
  type SiteAudienceClaims,
  type SiteAudienceRule,
  type SiteAudienceRuleKind,
  type SiteAudiencesResponse,
} from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { relativeTime } from '@/shared/api/api'
import { useCopy } from '@/shared/composables/use-copy'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { PageState } from '@/shared/layout'

const props = defineProps<{
  site: PublishedSiteSummary
  /** The project's pages in tree order, indented. */
  pages: { id: string; label: string }[]
  canManage: boolean
}>()

const { t } = useI18n()
const queryClient = useQueryClient()

const options = computed(() => apiQueryOptions('/v1/sites/{id}/audiences', { path: { id: props.site.id } }))
const query = useQuery(computed(() => ({ ...options.value, enabled: props.canManage })))
const data = computed(() => query.data.value as SiteAudiencesResponse | undefined)
const refetch = () => queryClient.invalidateQueries({ queryKey: options.value.queryKey })

// ------------------------------------------------------------------ rules

const editing = ref<string | null>(null)
const form = ref<{ documentId: string; audience: SiteAudienceRuleKind; claims: string }>({
  documentId: '',
  audience: 'members',
  claims: '',
})
const saving = ref(false)

/** `plan=pro, enterprise` per line → `{ plan: ['pro', 'enterprise'] }`; null when a line is not that shape. */
function parseClaims(text: string): SiteAudienceClaims | null | 'invalid' {
  const out: SiteAudienceClaims = {}
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const eq = line.indexOf('=')
    if (eq <= 0) return 'invalid'
    const key = line.slice(0, eq).trim()
    const values = line.slice(eq + 1).split(',').map((v) => v.trim()).filter(Boolean)
    if (!key || !values.length) return 'invalid'
    out[key] = [...(out[key] ?? []), ...values]
  }
  return Object.keys(out).length ? out : null
}
const formatClaims = (claims: SiteAudienceClaims | null) =>
  claims ? Object.entries(claims).map(([k, v]) => `${k}=${v.join(', ')}`).join('\n') : ''

const parsed = computed(() => (form.value.audience === 'visitors' ? parseClaims(form.value.claims) : null))
const canSave = computed(() => !!form.value.documentId && parsed.value !== 'invalid' && !saving.value)

function edit(rule: SiteAudienceRule) {
  editing.value = rule.documentId
  form.value = { documentId: rule.documentId, audience: rule.audience, claims: formatClaims(rule.claims) }
}
function reset() {
  editing.value = null
  form.value = { documentId: '', audience: 'members', claims: '' }
}

async function save() {
  if (!canSave.value || parsed.value === 'invalid') return
  saving.value = true
  try {
    await api.put('/v1/sites/{id}/audiences/{documentId}', {
      path: { id: props.site.id, documentId: form.value.documentId },
      body: { audience: form.value.audience, claims: parsed.value },
    })
    toast.success(t('site.audience.saved'))
    reset()
    await refetch()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

async function remove(rule: SiteAudienceRule) {
  try {
    await api.delete('/v1/sites/{id}/audiences/{documentId}', { path: { id: props.site.id, documentId: rule.documentId } })
    toast.success(t('site.audience.removed'))
    if (editing.value === rule.documentId) reset()
    await refetch()
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

// ------------------------------------------------------------ visitor auth

const secret = ref<string | null>(null)
const secretBusy = ref(false)
/** The step that signs visitors out, waiting for a second click. */
const confirming = ref<'rotate' | 'off' | null>(null)
const { state: copyState, copy } = useCopy()

async function rotate() {
  confirming.value = null
  secretBusy.value = true
  try {
    const res = await api.post('/v1/sites/{id}/visitor-secret', { path: { id: props.site.id } })
    secret.value = res.secret
    await refetch()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    secretBusy.value = false
  }
}

async function turnOff() {
  confirming.value = null
  secretBusy.value = true
  try {
    await api.delete('/v1/sites/{id}/visitor-secret', { path: { id: props.site.id } })
    secret.value = null
    toast.success(t('site.audience.turnedOff'))
    await refetch()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    secretBusy.value = false
  }
}

// Format examples, not copy: the same in every language.
const CLAIMS_EXAMPLE = 'plan=pro, enterprise'
const PAYLOAD_EXAMPLE = '{ "sub": "customer-42", "plan": "pro", "exp": 1767225600 }'
const linkExample = computed(() => `${props.site.url}/…?${SITE_VISITOR_TOKEN_PARAM}=<jwt>`)
</script>

<template>
  <div class="space-y-8">
    <section class="space-y-3">
      <p class="kn-measure text-sm text-muted-foreground">{{ t('site.audience.intro') }}</p>
      <p class="kn-measure text-sm text-muted-foreground">{{ t('site.audience.membersHint') }}</p>

      <PageState v-if="query.isPending.value" state="loading" :rows="2" row-class="h-10" />
      <ul v-else-if="data?.rules.length" class="divide-y rounded-md border">
        <li v-for="rule in data.rules" :key="rule.documentId" class="flex flex-wrap items-center gap-2 px-4 py-3">
          <span class="min-w-0 truncate font-medium">{{ rule.documentTitle }}</span>
          <Badge :variant="rule.audience === 'members' ? 'secondary' : 'outline'">{{ t(`site.audience.${rule.audience}`) }}</Badge>
          <span v-if="rule.audience === 'visitors'" class="min-w-0 truncate text-xs text-muted-foreground">
            <template v-if="rule.claims">
              <span v-for="(values, key) in rule.claims" :key="key" class="mr-2 font-mono">{{ t('site.audience.claim', { key, values: values.join(', ') }) }}</span>
            </template>
            <template v-else>{{ t('site.audience.anyVisitor') }}</template>
          </span>
          <span class="flex-1" />
          <template v-if="canManage">
            <Button size="icon" variant="ghost" class="size-7" :aria-label="t('site.audience.edit')" :title="t('site.audience.edit')" @click="edit(rule)">
              <Pencil class="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              class="size-7 text-destructive hover:text-destructive"
              :aria-label="t('site.audience.remove', { title: rule.documentTitle })"
              :title="t('site.audience.remove', { title: rule.documentTitle })"
              @click="remove(rule)"
            >
              <Trash2 class="size-4" />
            </Button>
          </template>
        </li>
      </ul>
      <p v-else class="text-sm text-muted-foreground">{{ t('site.audience.none') }}</p>

      <form v-if="canManage" class="max-w-3xl space-y-3 rounded-md border p-4" @submit.prevent="save">
        <p class="text-sm font-medium">{{ editing ? t('site.audience.editing') : t('site.audience.add') }}</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block space-y-1">
            <span class="text-xs font-medium text-muted-foreground">{{ t('site.audience.page') }}</span>
            <Select v-model="form.documentId" :disabled="!!editing">
              <SelectTrigger class="w-full"><SelectValue :placeholder="t('site.audience.pagePlaceholder')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in pages" :key="p.id" :value="p.id" class="whitespace-pre">{{ p.label }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label class="block space-y-1">
            <span class="text-xs font-medium text-muted-foreground">{{ t('site.audience.audience') }}</span>
            <Select v-model="form.audience">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="kind in SITE_AUDIENCE_RULE_KINDS" :key="kind" :value="kind">
                  {{ t(`site.audience.${kind}`) }} · {{ t(`site.audience.${kind}Desc`) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <label v-if="form.audience === 'visitors'" class="block space-y-1">
          <span class="text-xs font-medium text-muted-foreground">{{ t('site.audience.claims') }}</span>
          <Textarea v-model="form.claims" rows="3" class="font-mono text-sm" spellcheck="false" :placeholder="CLAIMS_EXAMPLE" />
          <p v-if="parsed === 'invalid'" class="text-xs text-destructive">{{ t('site.audience.claimsInvalid') }}</p>
          <p v-else class="text-xs text-muted-foreground">{{ t('site.audience.claimsHint') }}</p>
        </label>
        <div class="flex gap-2">
          <Button type="submit" size="sm" :disabled="!canSave">{{ t('site.audience.save') }}</Button>
          <Button v-if="editing" type="button" size="sm" variant="ghost" @click="reset">{{ t('site.audience.cancel') }}</Button>
        </div>
      </form>
    </section>

    <section v-if="data" class="space-y-3">
      <h2 class="text-sm font-semibold">{{ t('site.audience.visitorAuth') }}</h2>
      <p class="kn-measure text-sm text-muted-foreground">{{ t('site.audience.visitorAuthIntro', { minutes: data.sessionTtlMinutes }) }}</p>

      <p
        v-if="!data.visitorAuth.canStore"
        class="rounded-md border kn-callout-warning px-3 py-2 text-sm"
      >
        {{ t('site.audience.visitorNoKey') }}
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <Badge :variant="data.visitorAuth.configured ? 'default' : 'outline'">
          {{
            data.visitorAuth.configured
              ? t('site.audience.visitorAuthOn', { when: data.visitorAuth.setAt ? relativeTime(data.visitorAuth.setAt) : '—' })
              : t('site.audience.visitorAuthOff')
          }}
        </Badge>
        <span class="flex-1" />
        <template v-if="canManage">
          <Button
            size="sm"
            variant="outline"
            :disabled="secretBusy || !data.visitorAuth.canStore"
            @click="data.visitorAuth.configured ? (confirming = 'rotate') : rotate()"
          >
            {{ data.visitorAuth.configured ? t('site.audience.rotate') : t('site.audience.generate') }}
          </Button>
          <Button v-if="data.visitorAuth.configured" size="sm" variant="ghost" :disabled="secretBusy" @click="confirming = 'off'">
            {{ t('site.audience.turnOff') }}
          </Button>
        </template>
      </div>

      <div v-if="confirming" role="alert" class="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
        <p class="min-w-0 flex-1 text-sm">
          {{ confirming === 'rotate' ? t('site.audience.rotateConfirm') : t('site.audience.turnOffConfirm') }}
        </p>
        <Button size="sm" variant="destructive" :disabled="secretBusy" @click="confirming === 'rotate' ? rotate() : turnOff()">
          {{ confirming === 'rotate' ? t('site.audience.rotate') : t('site.audience.turnOff') }}
        </Button>
        <Button size="sm" variant="ghost" @click="confirming = null">{{ t('site.audience.cancel') }}</Button>
      </div>

      <div v-if="secret" class="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
        <p class="text-sm">{{ t('site.audience.secretOnce') }}</p>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 rounded bg-background px-2 py-1 font-mono text-xs break-all select-all">{{ secret }}</code>
          <Button size="sm" variant="outline" @click="copy(secret)">
            <Check v-if="copyState === 'copied'" class="size-3.5" aria-hidden="true" />
            <Copy v-else class="size-3.5" aria-hidden="true" />
            {{ copyState === 'copied' ? t('site.audience.copied') : t('site.audience.copySecret') }}
          </Button>
        </div>
        <p v-if="copyState === 'failed'" class="text-xs text-destructive">{{ t('site.audience.copyFailed') }}</p>
      </div>

      <dl v-if="data.visitorAuth.configured || secret" class="grid gap-x-3 gap-y-1 rounded-md bg-muted/40 p-3 text-xs sm:grid-cols-[auto_1fr]">
        <dt class="font-medium text-muted-foreground">{{ t('site.audience.example') }}</dt>
        <dd class="font-mono break-all">{{ PAYLOAD_EXAMPLE }}</dd>
        <dt class="font-medium text-muted-foreground">{{ t('site.audience.exampleUrl') }}</dt>
        <dd class="font-mono break-all">{{ linkExample }}</dd>
      </dl>
    </section>
  </div>
</template>
