<script setup lang="ts">
// Who else is in the shared draft (#80): their faces, in the hue their caret
// wears, so a caret in the text and a face in the header read as one person.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UserAvatar from '@/components/merge-requests/UserAvatar.vue'
import type { CollabPeer } from './use-collab'

const props = defineProps<{ peers: CollabPeer[] }>()
const { t } = useI18n()

/** Three faces fit beside the header's controls on a phone; the rest is a count. */
const SHOWN = 3
const shown = computed(() => props.peers.slice(0, SHOWN))
const more = computed(() => props.peers.length - shown.value.length)
const names = computed(() => props.peers.map((p) => p.name).join(', '))
</script>

<template>
  <div
    v-if="peers.length"
    class="kn-collab-presence"
    role="img"
    :aria-label="t('editor.collab.presence.editing', { n: peers.length, names }, peers.length)"
    :title="names"
  >
    <UserAvatar
      v-for="peer in shown"
      :key="peer.userId"
      :user-id="peer.userId"
      :name="peer.name"
      :src="peer.avatarUrl"
      size="sm"
    />
    <span v-if="more > 0" class="kn-collab-more" aria-hidden="true">+{{ more }}</span>
  </div>
</template>
