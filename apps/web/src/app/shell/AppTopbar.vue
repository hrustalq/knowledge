<script setup lang="ts">
// Top bar: nav toggle, global search ("/" or Cmd/Ctrl+K), notifications, user.
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { PanelLeft, Search } from 'lucide-vue-next'
import { useSearchUiStore } from '@/modules/documents'
import { isSearchShortcut } from '@/shared/utils/search-shortcut'
import { Button } from '@knowledge/ui/button'
import { NotificationBell } from '@/modules/notifications'
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
  <header class="kn-topbar sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur">
    <Button variant="ghost" size="icon-sm" :aria-label="t('nav.toggleSidebar')" @click="$emit('toggle-sidebar')">
      <PanelLeft class="size-4" />
    </Button>

    <!-- A trigger, not a field: the sheet owns the only live query input, so
         focus can't be tugged between two of them by the dialog focus trap.
         `min-w-0` lets it give way to the controls beside it (#647): a flex
         item is otherwise as wide as its placeholder, and the Russian one
         pushed the account menu off a phone screen. -->
    <button
      id="global-search-trigger"
      type="button"
      class="relative h-8 w-full min-w-0 max-w-sm rounded-md border bg-muted/40 pl-8 pr-10 text-left text-sm text-muted-foreground outline-none transition-colors max-sm:pr-3 hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
      aria-haspopup="dialog"
      :aria-label="t('nav.searchPages')"
      @click="searchUi.openSearch()"
    >
      <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
      <span class="block truncate">{{ t('nav.searchPagesPlaceholder') }}</span>
      <kbd
        class="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-micro sm:block"
      >/</kbd>
    </button>

    <div class="ml-auto flex items-center gap-1.5">
      <!-- Language and theme are settings that follow the device (#1040), in
           Profile settings: the bar keeps room for its own controls at 200% text. -->
      <NotificationBell />
      <UserMenu />
    </div>
  </header>
</template>
