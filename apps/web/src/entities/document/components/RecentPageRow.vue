<script setup lang="ts">
// One recently revised page (#1293), on the workspace home and the project page:
// the tree row's marks (lifecycle dot, the diamond when the page asks for a look),
// so the list says something the activity feed beside it does not.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import type { HomeRecentPage } from '@knowledge/contracts'
import { relativeTime, statusDot } from '@/shared/api/api'
import { labelFor } from '@/shared/i18n/labels'
import { needsAttention, VERIFICATION_MARK_CLASS, verificationDotClass } from '@/entities/document/model/verification-ui'

const props = defineProps<{ page: HomeRecentPage }>()
const { t } = useI18n()
/** Colour alone is not a state a screen reader can read. */
const statusLabel = computed(() => labelFor(t, 'revisionStatus', props.page.headRevisionStatus ?? 'draft'))
const verificationLabel = computed(() => t(`verification.state.${props.page.verification}`))
</script>

<template>
  <li class="flex items-center gap-2 px-4 py-2.5 text-sm">
    <span
      class="size-1.5 shrink-0 rounded-full"
      :class="statusDot(page.headRevisionStatus)"
      role="img"
      :aria-label="statusLabel"
      :title="statusLabel"
    />
    <RouterLink :to="`/documents/${page.documentId}`" class="-my-1 min-w-0 flex-1 truncate rounded-sm py-1 font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring">
      {{ page.title }}
    </RouterLink>
    <span
      v-if="needsAttention(page.verification)"
      :class="[VERIFICATION_MARK_CLASS, verificationDotClass(page.verification)]"
      role="img"
      :aria-label="verificationLabel"
      :title="verificationLabel"
    />
    <span class="shrink-0 text-xs text-muted-foreground">{{ relativeTime(page.updatedAt) }}</span>
  </li>
</template>
