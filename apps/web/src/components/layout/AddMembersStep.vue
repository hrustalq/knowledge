<script setup lang="ts">
/**
 * "Invite people" as a step — the follow-up a new project offers, since
 * collaborators are a workspace fact and a project is usually made in order to
 * share it with someone.
 *
 * People are added one at a time and stay listed as they land, so the step
 * doubles as its own receipt: the dismiss button is labelled "Skip for now"
 * while nothing has happened and "Done" once something has, because by then it
 * is no longer a skip.
 */
import { computed, ref } from 'vue'
import type {
  ListWorkspaceCandidatesResponse,
  ListWorkspaceMembersResponse,
  WorkspaceCandidate,
  WorkspaceRole,
} from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const props = defineProps<{ workspaceId: string; workspaceName?: string | null }>()
const emit = defineEmits<{ done: [] }>()

const ROLES: WorkspaceRole[] = ['viewer', 'editor', 'admin']

const role = ref<WorkspaceRole>('editor')
const adding = ref(false)
const error = ref<string | null>(null)
const added = ref<{ email: string; role: WorkspaceRole }[]>([])

// Candidate lookup is server-side and already excludes existing members, so
// the picker cannot offer someone who is on the list.
const cache = new Map<string, WorkspaceCandidate>()
async function loadCandidates(query: string): Promise<AutocompleteOption[]> {
  const params = new URLSearchParams({ limit: '20' })
  if (query.trim()) params.set('q', query.trim())
  const res = await apiFetch<ListWorkspaceCandidatesResponse>(
    `/v1/workspaces/${props.workspaceId}/candidates?${params}`,
  )
  for (const c of res.candidates) cache.set(c.userId, c)
  return res.candidates.map((c) => ({
    value: c.userId,
    label: `${c.displayName} · ${c.email}`,
    meta: c.disabled ? 'disabled' : undefined,
  }))
}

const picked = ref<WorkspaceCandidate | null>(null)
const pickedValue = computed<string[]>({
  get: () => (picked.value ? [picked.value.userId] : []),
  set: (v) => {
    picked.value = v[0] ? (cache.get(v[0]) ?? null) : null
  },
})

async function add() {
  const user = picked.value
  if (!user || adding.value) return
  adding.value = true
  error.value = null
  try {
    await apiFetch<ListWorkspaceMembersResponse>(`/v1/workspaces/${props.workspaceId}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: user.email, role: role.value }),
    })
    added.value = [...added.value, { email: user.email, role: role.value }]
    picked.value = null
    cache.delete(user.userId) // a member now, so no longer a candidate
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- Two rows rather than three controls crammed into a 350px dialog: the
         name field is the one that needs the width. Everything here is h-8 to
         sit on the Autocomplete's own line height. -->
    <Autocomplete
      v-model="pickedValue"
      label="Person"
      placeholder="Search by name or email…"
      :multiple="false"
      :load="loadCandidates"
      empty-hint="No one else to add to this workspace yet."
    />

    <div class="flex items-end gap-2">
      <div class="space-y-1.5">
        <Label
          for="add-members-step-role"
          class="text-muted-foreground block text-[11px] font-semibold tracking-wider uppercase"
        >
          Role
        </Label>
        <Select v-model="role">
          <SelectTrigger id="add-members-step-role" size="sm" class="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="r in ROLES" :key="r" :value="r">{{ r }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        class="ml-auto"
        :disabled="!picked || adding"
        @click="add"
      >
        {{ adding ? 'Adding…' : 'Add' }}
      </Button>
    </div>

    <p v-if="error" role="alert" class="text-destructive text-xs">{{ error }}</p>

    <ul v-if="added.length > 0" class="space-y-1" aria-live="polite">
      <li
        v-for="m in added"
        :key="m.email"
        class="bg-secondary/60 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs"
      >
        <span class="min-w-0 flex-1 truncate">{{ m.email }}</span>
        <span class="text-muted-foreground shrink-0">{{ m.role }}</span>
      </li>
    </ul>
    <p v-else class="text-muted-foreground text-xs">
      Members can see everything in {{ workspaceName ?? 'this workspace' }}.
    </p>

    <DialogFooter class="pt-2">
      <Button
        type="button"
        :variant="added.length > 0 ? 'default' : 'outline'"
        @click="emit('done')"
      >
        {{ added.length > 0 ? 'Done' : 'Skip for now' }}
      </Button>
    </DialogFooter>
  </div>
</template>
