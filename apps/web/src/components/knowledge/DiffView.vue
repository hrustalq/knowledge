<script setup lang="ts">
// Unified diff + structural section, extracted from RevisionsView so the MR
// Changes tab can reuse it. Thread rendering is delegated to the parent via
// the #thread slot — DiffView only decides WHERE an anchored thread appears
// (see thread-anchors.ts) and exposes a comment gutter when canComment.
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import type { CompareResponse, MergeRequestThread, MergeRequestThreadAnchor } from '@knowledge/contracts'
import { matchAnchoredThreads } from '@/components/merge-requests/thread-anchors'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    compare: CompareResponse
    threads?: MergeRequestThread[]
    canComment?: boolean
  }>(),
  { threads: () => [], canComment: false },
)

const emit = defineEmits<{ 'create-thread': [anchor: MergeRequestThreadAnchor] }>()

const inlineThreads = computed(() => matchAnchoredThreads(props.compare, props.threads).inline)

function commentOn(line: { new?: number; text: string }) {
  if (line.new === undefined) return
  emit('create-thread', {
    type: 'line',
    revisionId: props.compare.to.revisionId,
    line: line.new,
    excerpt: line.text,
  })
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="compare.structural && compare.structural.changes.length" class="rounded-md border p-3 text-sm">
      <p class="mb-1 text-xs font-medium text-muted-foreground">Structural ({{ compare.structural.source }})</p>
      <p v-for="(c, i) in compare.structural.changes" :key="i" class="font-mono text-xs">
        <span :class="c.kind === 'added' ? 'text-green-600' : c.kind === 'removed' ? 'text-red-600' : 'text-amber-600'">{{ c.kind }}</span>
        {{ c.path || '(root)' }}
      </p>
    </div>
    <p v-if="compare.hunks.length === 0" class="text-sm text-muted-foreground">{{ t('review.noLineChanges') }}</p>
    <div v-for="(hunk, hi) in compare.hunks" :key="hi" class="overflow-x-auto rounded-md border font-mono text-xs">
      <p class="bg-muted px-3 py-1 text-muted-foreground">
        @@ -{{ hunk.oldStart }},{{ hunk.oldLines }} +{{ hunk.newStart }},{{ hunk.newLines }} @@
      </p>
      <template v-for="(line, li) in hunk.lines" :key="li">
        <div
          class="group flex"
          :class="line.kind === 'added' ? 'bg-green-500/10 text-green-700 dark:text-green-400' : line.kind === 'deleted' ? 'bg-red-500/10 text-red-700 dark:text-red-400' : ''"
        >
          <button
            v-if="canComment && line.kind !== 'deleted' && line.new !== undefined"
            type="button"
            class="w-5 shrink-0 text-center text-muted-foreground opacity-0 hover:text-primary group-hover:opacity-100"
            :title="t('review.commentOnLine')"
            @click="commentOn(line)"
          >+</button>
          <span v-else class="w-5 shrink-0" />
          <pre class="flex-1 whitespace-pre-wrap px-1">{{ line.kind === 'added' ? '+' : line.kind === 'deleted' ? '-' : ' ' }}{{ line.text }}</pre>
        </div>
        <div
          v-for="thread in (line.new !== undefined ? inlineThreads.get(line.new) : undefined) ?? []"
          :key="thread.threadId"
          class="border-y bg-background px-3 py-2 font-sans"
        >
          <slot name="thread" :thread="thread" />
        </div>
      </template>
    </div>
  </div>
</template>
