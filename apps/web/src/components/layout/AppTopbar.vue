<script setup lang="ts">
// Top bar: nav toggle, global search ("/" or Cmd/Ctrl+K), theme toggle, user.
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Moon, PanelLeft, Search, Sun } from 'lucide-vue-next'
import { useSearchUiStore } from '@/stores/search-ui'
import { isSearchShortcut } from '@/lib/search-shortcut'
import { toggleTheme } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import LocaleSwitcher from './LocaleSwitcher.vue'
import NotificationBell from '@/components/notifications/NotificationBell.vue'
import UserMenu from './UserMenu.vue'

defineEmits<{ 'toggle-sidebar': [] }>()

const { t } = useI18n()
const searchUi = useSearchUiStore()

function onKeydown(e: KeyboardEvent) {
  if (!isSearchShortcut(e)) return
  e.preventDefault()
  searchUi.openSearch()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

</script>

<template>
  <header class="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur">
    <Button variant="ghost" size="icon-sm" :aria-label="t('nav.toggleSidebar')" @click="$emit('toggle-sidebar')">
      <PanelLeft class="size-4" />
    </Button>

    <!-- A trigger, not a field: the sheet owns the only live query input, so
         focus can't be tugged between two of them by the dialog focus trap. -->
    <button
      id="global-search-trigger"
      type="button"
      class="relative h-8 w-full max-w-sm rounded-md border bg-muted/40 pl-8 pr-10 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      aria-haspopup="dialog"
      :aria-label="t('nav.searchPages')"
      @click="searchUi.openSearch()"
    >
      <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
      {{ t('nav.searchPagesPlaceholder') }}
      <kbd
        class="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[10px] sm:block"
      >/</kbd>
    </button>

    <div class="ml-auto flex items-center gap-1.5">
      <NotificationBell />
      <LocaleSwitcher />
      <Button variant="ghost" size="icon-sm" :aria-label="t('nav.toggleTheme')" @click="toggleTheme">
        <Sun class="hidden size-4 dark:block" />
        <Moon class="size-4 dark:hidden" />
      </Button>
      <UserMenu />
    </div>
  </header>
</template>
