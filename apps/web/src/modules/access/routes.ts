import type { RouteRecordRaw } from 'vue-router'

import { CONNECT_SETUP_PATH } from './model/connect-setup-path'
import { PURPOSE_SETUP_PATH } from './model/purpose-setup-path'

export { CONNECT_SETUP_PATH, PURPOSE_SETUP_PATH }

export const routes: RouteRecordRaw[] = [
  // No `meta.feature`: this is how the sections get chosen, so none of them gates it.
  { path: PURPOSE_SETUP_PATH, component: () => import('./pages/PurposeSetupPage.vue') },
  // Connecting an AI client (#1225): a full-screen wizard, so `focus` drops the
  // shell. `?client=` opens it on that client; `?next=` is where Close goes.
  { path: CONNECT_SETUP_PATH, component: () => import('./pages/ConnectWizardPage.vue'), meta: { focus: true } },
  // A person, inside this workspace. `/u` with no id is your own — the
  // avatar menu's target, and a link that stays right after a rename.
  { path: '/u', component: () => import('./pages/ProfilePage.vue') },
  { path: '/u/:userId', component: () => import('./pages/ProfilePage.vue') },
  // Legacy top-level paths → their settings home
  { path: '/access', redirect: '/settings/access' },
]

export const settingsRoutes: RouteRecordRaw[] = [
  { path: 'general', component: () => import('./pages/GeneralSettingsPage.vue') },
  // Your own account: name, language, password, API key. Open to every
  // role — it takes no user id, so there is nobody else to act on.
  { path: 'profile', component: () => import('./pages/ProfileSettingsPage.vue') },
  // Connect AI moved into /settings/ai as a section (issue #182). Kept
  // as a redirect: this URL is printed into every SKILL.md already
  // handed to a client. A string redirect keeps the query, so
  // `?client=` still opens the client it named.
  { path: 'connect', redirect: '/settings/ai/connect' },
  // Access: workspace members, what each role grants, groups and
  // requests. The page gates mutations by workspace role. The accounts
  // themselves are the admin console's (/admin/users, #1239).
  { path: 'access', component: () => import('./pages/AccessControlPage.vue') },
  // Sign-in and the audit trail (#75): workspace administration, so the
  // router refuses anyone else (#1299) and the API enforces admin.
  { path: 'security', component: () => import('./pages/SecuritySettingsPage.vue'), meta: { permission: 'workspace:admin' } },
  // Which sections the workspace shows (#604): admin-only the same way.
  { path: 'features', component: () => import('./pages/FeaturesSettingsPage.vue'), meta: { permission: 'workspace:admin' } },
  // How an edit reaches a page (#958): admin-only the same way.
  { path: 'editing', component: () => import('./pages/EditingSettingsPage.vue'), meta: { permission: 'workspace:admin' } },
  // Accounts were a nav row here, then a tab of /settings/access, and are
  // now the admin console's (#1239). Kept as a redirect: a bookmark lands
  // on the members list, whose header links a platform admin onward.
  { path: 'users', redirect: '/settings/access' },
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
  // `?client=` was "open the setup for this client" in every SKILL.md handed
  // out; setup is the wizard now (#1225), so the link goes there.
  beforeEnter: (to) =>
    typeof to.query.client === 'string' ? { path: CONNECT_SETUP_PATH, query: { client: to.query.client } } : true,
}
