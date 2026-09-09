<script setup lang="ts">
// Top bar: nav toggle, global search ("/" or Cmd/Ctrl+K), theme toggle, user.
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { LogOut, Moon, PanelLeft, Search, Sun } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useSearchUiStore } from '@/stores/search-ui'
import { toggleTheme } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import LocaleSwitcher from './LocaleSwitcher.vue'

defineEmits<{ 'toggle-sidebar': [] }>()

const { t } = useI18n()
const auth = useAuthStore()
const router = useRouter()
const searchUi = useSearchUiStore()

const initials = computed(() =>
  (auth.me?.displayName ?? '?')
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase(),
)

function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  const typing =
    target !== null &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    // Inside a rich editor ⌘K means "link this selection" — the convention in
    // every editor people arrive from. Firing search there too opened both at
    // once. Plain inputs keep the global shortcut.
    if (target?.isContentEditable || e.defaultPrevented) return
    e.preventDefault()
    searchUi.openSearch()
    return
  }
  if (!typing && e.key === '/') {
    e.preventDefault()
    searchUi.openSearch()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

async function logout() {
  await auth.logout()
  await router.push('/login')
}
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
      <LocaleSwitcher />
      <Button variant="ghost" size="icon-sm" :aria-label="t('nav.toggleTheme')" @click="toggleTheme">
        <Sun class="hidden size-4 dark:block" />
        <Moon class="size-4 dark:hidden" />
      </Button>
      <div v-if="auth.me" class="hidden items-center gap-2 pl-1 sm:flex" :title="auth.me.email">
        <span class="grid size-7 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
          {{ initials }}
        </span>
        <div class="leading-tight">
          <p class="text-xs font-medium">{{ auth.me.displayName }}</p>
          <p class="text-[10px] text-muted-foreground">{{ auth.role ? t(`role.${auth.role}`) : t('nav.noRole') }}</p>
        </div>
      </div>
      <Button v-if="!auth.isDev" variant="ghost" size="icon-sm" :aria-label="t('nav.logOut')" :title="t('nav.logOut')" @click="logout">
        <LogOut class="size-4" />
      </Button>
    </div>
  </header>
</template>
