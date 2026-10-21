<script setup lang="ts">
/**
 * The status bar at the top of a page (docs/features/39, issue #66 phase 5):
 * what the page's verification reads as, who answers for it, and the one row
 * of actions a person has over that.
 *
 * Everything shown is the derived state the API already computed
 * (`verificationStateFor`); nothing here decides what the page *is*. The
 * actions are the REST routes one to one, hidden when the caller's role cannot
 * take them — the same roles the routes enforce, so a hidden button is never a
 * surprise 403 and a visible one never a lie.
 *
 * An archived page swaps the bar for a banner: the stamp and the flag mean
 * nothing on a page that has been put away, and the one action left is to
 * bring it back.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Archive, ArchiveRestore, BadgeCheck, ChevronDown, ExternalLink, MoreHorizontal } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type { ArchiveDocumentResponse, DocumentDetailResponse, DocumentSummary, VerificationFlag } from '@knowledge/contracts'
import { VERIFICATION_NOTE_MAX_CHARS } from '@knowledge/contracts'
import { apiFetch, relativeTime } from '@/lib/api'
import { formatDate, formatDateTime } from '@/lib/format'
import { errorMessage } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useMembers } from '@/components/merge-requests/use-members'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import OwnerPicker from './OwnerPicker.vue'
import WorkItemChips from '@/components/knowledge/WorkItemChips.vue'
import { INTERVAL_CHOICES, flagSourceWho, intervalFromKey, intervalKey, verificationDotClass } from './verification-ui'

const props = defineProps<{ detail: DocumentDetailResponse }>()
const emit = defineEmits<{
  /** The route answered with the whole detail: hand it up as is. */
  'update:detail': [detail: DocumentDetailResponse]
  /** The route answered with something smaller: the page re-reads itself. */
  reload: []
}>()

const { t } = useI18n()
const auth = useAuthStore()
const { nameOf } = useMembers()

const doc = computed(() => props.detail.document)
const state = computed(() => doc.value.verification ?? 'unverified')
const dotClass = computed(() => verificationDotClass(state.value))
const archived = computed(() => !!doc.value.archivedAt)
const note = computed(() => doc.value.verificationNote?.trim() || null)

/* ------------------------------------------------------------- sentence */

const verifier = computed(() => nameOf(doc.value.verifiedBy))
const verifiedWhen = computed(() => (doc.value.verifiedAt ? relativeTime(doc.value.verifiedAt) : ''))
const source = computed(() => doc.value.verificationSource ?? null)
const sourceWho = computed(() => {
  const who = flagSourceWho(source.value)
  return who === 'person' ? nameOf(source.value?.by) : t(`verification.source.${who}`)
})
const sourceWhen = computed(() => (source.value?.at ? relativeTime(source.value.at) : ''))

const sentence = computed(() => {
  const who = verifier.value
  const when = verifiedWhen.value
  switch (state.value) {
    case 'verified':
      return t('verification.describe.verified', { who, when })
    case 'edited':
      return t('verification.describe.edited', { who, when })
    case 'expired':
      return t('verification.describe.expired', { who, when })
    case 'requested':
      return t('verification.describe.requested', { who: sourceWho.value, when: sourceWhen.value })
    case 'outdated':
      return t('verification.describe.outdated', { who: sourceWho.value, when: sourceWhen.value })
    case 'flagged':
      return t('verification.describe.flagged')
    default:
      return t('verification.describe.unverified')
  }
})

/** Only a live stamp has a deadline worth naming. */
const expiry = computed(() => {
  if (state.value !== 'verified') return null
  const at = doc.value.verificationExpiresAt
  return at
    ? t('verification.describe.expires', { when: formatDate(at) })
    : t('verification.describe.neverExpires')
})

/** The pull request a drift flag came from, when there is one to open. */
const sourceUrl = computed(() =>
  (state.value === 'requested' || state.value === 'outdated') && source.value?.url ? source.value.url : null,
)

/* --------------------------------------------------------------- actions */

const busy = ref(false)

async function run(fn: () => Promise<DocumentDetailResponse | null>, done: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const next = await fn()
    if (next) emit('update:detail', next)
    else emit('reload')
    toast.success(t(done))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

const id = computed(() => doc.value.documentId)

/** The menu's current value is the page's own interval, so re-verifying keeps it unless a different row is picked. */
const intervalValue = computed(() => intervalKey(doc.value.reviewIntervalDays))

function verify(key: string) {
  const days = intervalFromKey(key)
  // The page's current choice is sent as-is (`null` = inherit) rather than
  // omitted: omitting keeps whatever is stored, which is the same thing, but
  // sending it makes the request say what the person saw checked.
  void run(
    () => apiFetch<DocumentDetailResponse>(`/v1/documents/${id.value}/verify`, { method: 'POST', body: JSON.stringify({ intervalDays: days }) }),
    'verification.toast.verified',
  )
}

function clear() {
  void run(
    () => apiFetch<DocumentDetailResponse>(`/v1/documents/${id.value}/verify`, { method: 'DELETE' }),
    'verification.toast.cleared',
  )
}

/** Request / outdated share one dialog: a note and a verb. */
const flagDialog = ref<VerificationFlag | null>(null)
const flagNote = ref('')
function openFlag(flag: VerificationFlag) {
  flagNote.value = ''
  flagDialog.value = flag
}
function submitFlag() {
  const flag = flagDialog.value
  if (!flag) return
  const route = flag === 'outdated' ? 'outdated' : 'verification-request'
  const body = flagNote.value.trim() ? { note: flagNote.value.trim() } : {}
  flagDialog.value = null
  void run(
    () => apiFetch<DocumentDetailResponse>(`/v1/documents/${id.value}/${route}`, { method: 'POST', body: JSON.stringify(body) }),
    flag === 'outdated' ? 'verification.toast.outdated' : 'verification.toast.requested',
  )
}

function setOwner(ownerId: string | null) {
  void run(async () => {
    await apiFetch<DocumentSummary>(`/v1/documents/${id.value}`, { method: 'PATCH', body: JSON.stringify({ ownerId }) })
    return null
  }, 'verification.toast.ownerChanged')
}

const archiveOpen = ref(false)
const withDescendants = ref(true)
function archive() {
  archiveOpen.value = false
  void run(async () => {
    await apiFetch<ArchiveDocumentResponse>(`/v1/documents/${id.value}/archive`, {
      method: 'POST',
      body: JSON.stringify({ includeDescendants: withDescendants.value }),
    })
    return null
  }, 'verification.toast.archived')
}
function unarchive() {
  void run(async () => {
    await apiFetch<ArchiveDocumentResponse>(`/v1/documents/${id.value}/unarchive`, { method: 'POST', body: '{}' })
    return null
  }, 'verification.toast.unarchived')
}

/** Clearing means something only when there is a stamp or a flag to take off. */
const canClear = computed(() => !!doc.value.verifiedRevisionId || !!doc.value.verificationFlag)
/** Asking for a check on a page already asked about, or declared wrong, adds nothing. */
const canRequest = computed(() => state.value !== 'requested' && state.value !== 'outdated')
const archivedBy = computed(() => nameOf(doc.value.archivedBy))
</script>

<template>
  <!-- Archived: the banner, and the way back. -->
  <div v-if="archived" class="space-y-1.5 text-sm" role="status">
    <p class="flex items-start gap-1.5 text-xs leading-snug text-muted-foreground" :title="formatDateTime(doc.archivedAt!)">
      <Archive class="mt-0.5 size-3.5 shrink-0 text-panel-warning-ink" aria-hidden="true" />
      <span class="min-w-0">{{ t('verification.archived.banner', { when: relativeTime(doc.archivedAt!), who: archivedBy }) }}</span>
    </p>
    <Button v-if="auth.canEdit" variant="outline" size="xs" :disabled="busy" @click="unarchive">
      <ArchiveRestore class="size-3" />
      {{ t('verification.action.unarchive') }}
    </Button>
  </div>

  <div v-else class="space-y-1 text-sm">
    <!-- The state itself is the row's preview; in here, the sentence that
         explains it, the note behind a flag, and the inactivity reading — one
         tight group, with the action row set a little apart under it. -->
    <p class="text-xs leading-snug text-muted-foreground">
      <span class="mr-1.5 inline-block size-1.5 -translate-y-px rounded-full" :class="dotClass" aria-hidden="true" />{{ sentence }}<template v-if="expiry"> · {{ expiry }}</template>
      <a
        v-if="sourceUrl"
        :href="sourceUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="ml-1 inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
      >
        {{ t('verification.sourceLink') }}
        <ExternalLink class="size-3" aria-hidden="true" />
      </a>
      <Badge v-if="doc.inactive" variant="outline" class="ml-1.5 align-middle text-muted-foreground" :title="t('verification.inactiveHint')">
        {{ t('verification.inactive') }}
      </Badge>
    </p>
    <!-- The note is user or agent text: rendered as text, never as markup. -->
    <q v-if="note" class="line-clamp-3 text-xs leading-snug text-muted-foreground italic" :title="note">{{ note }}</q>
    <!-- #424: a flagged page can be handed off as a "check this page" ticket;
         the ticket stays shown after the flag clears, until it is unlinked. -->
    <WorkItemChips source-kind="verification" :source-id="id" :can-handoff="auth.canEdit && !!doc.verificationFlag" class="pt-1" />

    <div class="flex flex-wrap items-center gap-1 pt-1.5">
      <OwnerPicker :owner-id="doc.ownerId ?? null" :can-edit="auth.canEdit" :disabled="busy" @change="setOwner" />
      <span class="flex-1" aria-hidden="true" />

      <!-- Any member may ask; it is the comment role, not the editor one. An
           editor finds it under the menu instead, so the row stays one line:
           verifying is what an editor mostly does here, asking is the
           exception. -->
      <Button
        v-if="auth.canComment && !auth.canEdit && canRequest"
        variant="outline"
        size="xs"
        :disabled="busy"
        @click="openFlag('requested')"
      >
        {{ t('verification.action.request') }}
      </Button>

      <DropdownMenu v-if="auth.canEdit">
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="xs" :disabled="busy" :aria-pressed="state === 'verified'">
            <BadgeCheck class="size-3" :class="state === 'verified' ? 'text-panel-tip-ink' : ''" />
            {{ state === 'verified' ? t('verification.action.verified') : t('verification.action.verify') }}
            <ChevronDown class="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-60">
          <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">
            {{ t('verification.action.verifyAt', { n: detail.revision.revisionNumber }) }} · {{ t('verification.interval.title') }}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup :model-value="intervalValue" @update:model-value="(v) => typeof v === 'string' && verify(v)">
            <DropdownMenuRadioItem v-for="choice in INTERVAL_CHOICES" :key="intervalKey(choice)" :value="intervalKey(choice)">
              <template v-if="choice === null">{{ t('verification.interval.default') }}</template>
              <template v-else-if="choice === 0">{{ t('verification.interval.never') }}</template>
              <template v-else>{{ t('verification.interval.days', { n: choice }, choice) }}</template>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu v-if="auth.canEdit">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-xs" :disabled="busy" :aria-label="t('verification.action.more')">
            <MoreHorizontal class="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-56">
          <DropdownMenuItem v-if="canRequest" @select="openFlag('requested')">
            {{ t('verification.action.request') }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="state !== 'outdated'" @select="openFlag('outdated')">
            {{ t('verification.action.outdated') }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="canClear" @select="clear">
            {{ t('verification.action.clear') }}
          </DropdownMenuItem>
          <DropdownMenuSeparator v-if="canRequest || state !== 'outdated' || canClear" />
          <DropdownMenuItem @select="archiveOpen = true">
            <Archive class="size-3.5" />
            {{ t('verification.action.archive') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>

  <!-- Request / outdated: a note the owner will read. -->
  <Dialog :open="flagDialog !== null" @update:open="(v: boolean) => !v && (flagDialog = null)">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>
          {{ flagDialog === 'outdated' ? t('verification.outdatedDialog.title') : t('verification.requestDialog.title') }}
        </DialogTitle>
        <DialogDescription>
          {{ flagDialog === 'outdated' ? t('verification.outdatedDialog.description') : t('verification.requestDialog.description') }}
        </DialogDescription>
      </DialogHeader>
      <Textarea
        v-model="flagNote"
        rows="3"
        :maxlength="VERIFICATION_NOTE_MAX_CHARS"
        :placeholder="flagDialog === 'outdated' ? t('verification.outdatedDialog.notePlaceholder') : t('verification.requestDialog.notePlaceholder')"
        :aria-label="t('verification.note')"
      />
      <DialogFooter>
        <Button variant="ghost" @click="flagDialog = null">{{ t('common.cancel') }}</Button>
        <Button :variant="flagDialog === 'outdated' ? 'destructive' : 'default'" @click="submitFlag">
          {{ flagDialog === 'outdated' ? t('verification.outdatedDialog.submit') : t('verification.requestDialog.submit') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Archive is reversible, but it takes a subtree with it by default and
       hides the page from everyone: worth one question. -->
  <AlertDialog :open="archiveOpen" @update:open="(v: boolean) => (archiveOpen = v)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t('verification.archiveDialog.title', { title: doc.title }) }}</AlertDialogTitle>
        <AlertDialogDescription>{{ t('verification.archiveDialog.description') }}</AlertDialogDescription>
      </AlertDialogHeader>
      <Label class="flex cursor-pointer items-center gap-2 text-sm font-normal">
        <Checkbox :model-value="withDescendants" @update:model-value="(v) => (withDescendants = v === true)" />
        {{ t('verification.archiveDialog.withDescendants') }}
      </Label>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
        <AlertDialogAction @click="archive">{{ t('verification.archiveDialog.confirm') }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
