<script setup lang="ts">
// A branch's shared draft (#80), told on the pages that show what is
// published: the document page and a merge request. A dot and one line, like
// CollabStatus — how many have it open, who wrote what is not published yet —
// and nothing at all when neither holds, which is every page of a deployment
// with COLLAB_ENABLED off (the route answers no drafts there).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type { ListCollabDraftsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import UserChip from '@/widgets/person/UserChip.vue'

const props = defineProps<{
  documentId: string
  /** The branch whose draft to tell about, by name. */
  branch: string
  /** On a merge request the draft is the source branch's, which changes what the line says. */
  context: 'page' | 'mr'
}>()
const { t } = useI18n()

const drafts = useQuery(computed(() => apiQueryOptions('/v1/documents/{id}/drafts', { path: { id: props.documentId } })))
const draft = computed(
  () => (drafts.data.value as ListCollabDraftsResponse | undefined)?.drafts.find((d) => d.branch === props.branch) ?? null,
)
const editing = computed(() => draft.value?.activePeers ?? 0)
const unpublished = computed(() => draft.value?.hasUnpublishedChanges ?? false)
/** Faces only: the line is a pointer into the editor, where the names are. */
const SHOWN = 3
const writers = computed(() => (unpublished.value ? (draft.value?.contributors ?? []).slice(0, SHOWN) : []))
const more = computed(() => (draft.value?.contributors.length ?? 0) - writers.value.length)
const editHref = computed(() => ({
  path: `/documents/${props.documentId}/edit`,
  query: props.context === 'mr' ? { branch: props.branch } : {},
}))
</script>

<template>
  <p v-if="draft && (editing > 0 || unpublished)" class="kn-draft-badge">
    <span class="kn-collab-status" :data-tone="editing > 0 ? 'live' : 'idle'">
      <span class="kn-collab-dot" aria-hidden="true" />
      <span v-if="editing > 0">{{ t('editor.collab.badge.editing', { n: editing }, editing) }}</span>
    </span>
    <template v-if="unpublished">
      <span>{{ context === 'mr' ? t('editor.collab.badge.unpublishedMr') : t('editor.collab.badge.unpublished') }}</span>
      <span v-if="writers.length" class="kn-collab-presence">
        <UserChip v-for="id in writers" :key="id" :user-id="id" size="sm" avatar-only />
        <span v-if="more > 0" class="kn-collab-more" aria-hidden="true">+{{ more }}</span>
      </span>
    </template>
    <RouterLink :to="editHref" class="kn-draft-badge-link">{{ t('editor.collab.badge.open') }}</RouterLink>
  </p>
</template>
