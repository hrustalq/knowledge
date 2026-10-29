import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // A person, inside this workspace. `/u` with no id is your own — the
  // avatar menu's target, and a link that stays right after a rename.
  { path: '/u', component: () => import('./pages/ProfilePage.vue') },
  { path: '/u/:userId', component: () => import('./pages/ProfilePage.vue') },
  // Legacy top-level paths → their settings home
  { path: '/access', redirect: '/settings/access' },
  { path: '/admin/users', redirect: '/settings/access?tab=accounts' },
]

export const settingsRoutes: RouteRecordRaw[] = [
  // Your own account: name, language, password, API key. Open to every
  // role — it takes no user id, so there is nobody else to act on.
  { path: 'profile', component: () => import('./pages/ProfileSettingsPage.vue') },
  // Connect AI moved into /settings/ai as a section (issue #182). Kept
  // as a redirect: this URL is printed into every SKILL.md already
  // handed to a client. A string redirect keeps the query, so
  // `?client=` still opens the client it named.
  { path: 'connect', redirect: '/settings/ai/connect' },
  // Access: workspace members, what each role grants, and — for a
  // platform admin — the accounts themselves. The page gates mutations
  // by workspace role, and hides the Accounts tab for anyone the API's
  // @PlatformAdmin guard would refuse.
  { path: 'access', component: () => import('./pages/AccessControlPage.vue') },
  // Sign-in and the audit trail (#75): workspace administration, so the
  // page gates on auth.canAdminWorkspace and the API enforces admin.
  { path: 'security', component: () => import('./pages/SecuritySettingsPage.vue') },
  // Accounts moved into /settings/access as a tab. Kept as a redirect
  // rather than deleted: it was a nav row and a bookmark for as long as
  // the settings shell has existed. No `platformAdmin` meta — the
  // destination decides what to show, and bouncing a workspace admin to
  // /403 for following their own bookmark is worse than landing them on
  // the members list.
  { path: 'users', redirect: '/settings/access?tab=accounts' },
]

/**
 * Connect AI: a section of /settings/ai that is access's page (your own keys,
 * client config snippets and the skill). The assistant's settings route
 * places it among its sections; app/router hands it over, since modules never
 * import each other.
 */
export const connectAiRoute: RouteRecordRaw = {
  // Yours: API keys, client config snippets and the skill
  // (docs/features/33). Open to every role — it acts on your own
  // keys, and each tool a connected client calls is checked on its own.
  path: 'connect',
  component: () => import('./pages/ConnectAiPage.vue'),
}
