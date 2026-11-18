<script setup lang="ts">
/**
 * The console's rail (#1236): the member app's rail (apps/web app/shell/AppSidebar.vue),
 * reduced to what running the platform needs — the brand, four sections and the
 * way back. Below `lg` (the shell's one hinge, DESIGN.md) it becomes a header,
 * the four sections sharing its width as a tab row, so no drawer is needed.
 */
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { ArrowLeft, Library } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { NAV_CURRENT, NAV_IDLE, SECTION_NAV } from './nav'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
</script>

<template>
  <aside
    class="border-sidebar-border bg-sidebar text-sidebar-foreground flex flex-col border-b lg:sticky lg:top-0 lg:h-dvh lg:border-r lg:border-b-0"
  >
    <div class="flex items-center gap-2 px-4 pt-4 pb-3">
      <span class="bg-primary text-primary-foreground grid size-7 shrink-0 place-items-center rounded-md">
        <Library class="size-4" />
      </span>
      <span class="font-display text-base font-bold tracking-tight">Knowledge</span>
      <span class="text-muted-foreground text-xs font-medium">{{ t('admin.title') }}</span>
      <!-- The rail's footer is desktop-only, so the way back sits here below lg. -->
      <a
        href="/"
        class="hover:bg-sidebar-accent -mr-1.5 ml-auto grid size-9 place-items-center rounded-md transition-colors lg:hidden"
        :class="NAV_IDLE"
        :aria-label="t('admin.backToApp')"
        :title="t('admin.backToApp')"
      >
        <ArrowLeft class="size-4" aria-hidden="true" />
      </a>
    </div>

    <nav class="grid grid-cols-4 gap-px px-2 pb-2 lg:flex lg:flex-col lg:pb-0" :aria-label="t('admin.nav.label')">
      <RouterLink
        v-for="item in SECTION_NAV"
        :key="item.to"
        :to="item.to"
        class="text-caption flex min-w-0 flex-col items-center gap-1 rounded-md px-1 py-1.5 transition-colors lg:flex-row lg:gap-2.5 lg:px-2.5 lg:text-sm"
        :class="route.path.startsWith(item.to) ? NAV_CURRENT : NAV_IDLE"
      >
        <component :is="item.icon" class="size-4 shrink-0" aria-hidden="true" />
        <span class="max-w-full truncate">{{ t(item.labelKey) }}</span>
      </RouterLink>
    </nav>

    <div class="mt-auto hidden space-y-2 border-t px-4 py-3 lg:block">
      <p v-if="auth.me" class="text-muted-foreground text-caption truncate">
        {{ t('admin.signedInAs', { name: auth.me.displayName || auth.me.email }) }}
      </p>
      <a href="/" class="-mx-1 flex items-center gap-2 rounded-md px-1 py-1 text-sm transition-colors" :class="NAV_IDLE">
        <ArrowLeft class="size-4 shrink-0" aria-hidden="true" />
        {{ t('admin.backToApp') }}
      </a>
    </div>
  </aside>
</template>
