<script setup lang="ts">
/**
 * Level 0 of the rail's stack: the project roster.
 *
 * Every row is a door, so every row says so the same way — monogram, name,
 * page count, chevron — and the chevron leans right on hover, in the same
 * direction the pane is about to travel. The count sits in tabular figures so
 * the column of numbers stays a column instead of wobbling per digit.
 */
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { hueOf, initialsOf } from '@/lib/monogram'
import { ChevronRight, Plus } from 'lucide-vue-next'
import { Skeleton } from '@/components/ui/skeleton'

const { t } = useI18n()

defineEmits<{ open: [projectId: string]; create: [] }>()

const auth = useAuthStore()
const projects = useProjectsStore()
</script>

<template>
  <div class="absolute inset-0 z-0 flex flex-col">
    <div class="flex h-7 shrink-0 items-center justify-between px-4">
      <h2 class="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
        Projects
      </h2>
      <button
        v-if="auth.canEdit"
        type="button"
        :title="t('nav.newProject')"
        :aria-label="t('nav.newProject')"
        class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground grid size-6 place-items-center rounded transition-colors"
        @click="$emit('create')"
      >
        <Plus class="size-4" />
      </button>
    </div>

    <div class="sidebar-scroll mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <div v-if="!projects.loaded" class="space-y-1.5 px-1 pt-1">
        <Skeleton v-for="i in 4" :key="i" class="h-8 w-full" />
      </div>

      <p v-else-if="projects.items.length === 0" class="text-muted-foreground px-2.5 pt-1 text-xs">
        No projects yet<template v-if="auth.canEdit">
          —
          <button type="button" class="text-primary hover:underline" @click="$emit('create')">
            {{ t('nav.createFirstPage') }}
          </button></template>.
      </p>

      <ul v-else class="space-y-px">
        <li v-for="p in projects.items" :key="p.projectId">
          <button
            type="button"
            class="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-left text-sm transition-colors"
            :class="p.projectId === projects.activeId
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'"
            :aria-current="p.projectId === projects.activeId ? 'true' : undefined"
            @click="$emit('open', p.projectId)"
          >
            <span
              class="grid size-5 shrink-0 place-items-center rounded-[6px] text-[9px] font-semibold text-white"
              :style="{ backgroundColor: `hsl(${hueOf(p.projectId)} 55% 45%)` }"
              aria-hidden="true"
            >{{ initialsOf(p.name) }}</span>

            <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>

            <span class="text-muted-foreground shrink-0 text-[11px] tabular-nums">
              {{ p.documentCount }}
            </span>
            <ChevronRight
              class="text-muted-foreground/50 group-hover:text-muted-foreground size-3.5 shrink-0 transition-[transform,color] group-hover:translate-x-0.5"
            />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
