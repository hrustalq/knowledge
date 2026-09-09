<script setup lang="ts">
/**
 * The topbar identity block — now a menu rather than a label.
 *
 * The avatar is the shared `UserAvatar`, not a local initials chip. It used to
 * be one, tinted `bg-primary/15`, which meant the one place your own identity
 * is always on screen showed a *different* mark from the one every comment
 * pin, review byline and member list draws for you. Identity in this product is
 * derived from the user id and must be derived the same way everywhere.
 *
 * Name and role stay visible beside it: the workspace role is the fact that
 * decides whether the next click will work, and hiding it inside the menu would
 * trade a permanent answer for a click.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { ChevronDown, LogOut, Settings, UserRound } from 'lucide-vue-next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import UserAvatar from '@/components/merge-requests/UserAvatar.vue'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const auth = useAuthStore()
const router = useRouter()

const roleLabel = computed(() => (auth.role ? t(`role.${auth.role}`) : t('nav.noRole')))

async function logout() {
  await auth.logout()
  void router.push('/login')
}
</script>

<template>
  <DropdownMenu v-if="auth.me">
    <DropdownMenuTrigger
      class="flex items-center gap-2 rounded-md py-1 pl-1 pr-1.5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=open]:bg-accent"
      :aria-label="t('nav.accountMenu')"
    >
      <UserAvatar :user-id="auth.me.userId" :name="auth.me.displayName" />
      <span class="hidden text-left leading-tight sm:block">
        <span class="block max-w-32 truncate text-xs font-medium">{{ auth.me.displayName }}</span>
        <span class="block text-[10px] text-muted-foreground">{{ roleLabel }}</span>
      </span>
      <ChevronDown class="hidden size-3.5 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="min-w-56">
      <!-- The header repeats what the trigger shows, because below `sm` the
           trigger shows only the avatar and this is the only place the name
           and the account it belongs to appear at all. -->
      <DropdownMenuLabel class="flex items-center gap-2.5 py-2 font-normal">
        <UserAvatar :user-id="auth.me.userId" :name="auth.me.displayName" />
        <span class="min-w-0">
          <span class="block truncate text-sm font-medium">{{ auth.me.displayName }}</span>
          <span class="block truncate text-xs text-muted-foreground">{{ auth.me.email }}</span>
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />

      <DropdownMenuItem as-child>
        <RouterLink to="/u" class="cursor-pointer">
          <UserRound class="size-4" />
          {{ t('nav.yourProfile') }}
        </RouterLink>
      </DropdownMenuItem>
      <DropdownMenuItem as-child>
        <RouterLink to="/settings/profile" class="cursor-pointer">
          <Settings class="size-4" />
          {{ t('nav.accountSettings') }}
        </RouterLink>
      </DropdownMenuItem>

      <!-- AUTH_MODE=none has no session to end; offering a sign-out that
           cannot sign anyone out would be a dead control. -->
      <template v-if="!auth.isDev">
        <DropdownMenuSeparator />
        <DropdownMenuItem class="cursor-pointer" @select="logout">
          <LogOut class="size-4" />
          {{ t('nav.logOut') }}
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
