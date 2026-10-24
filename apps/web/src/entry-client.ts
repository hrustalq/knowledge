import type { StateTree } from 'pinia'
import { createApp } from './main'
import { ensureLocaleMessages } from './i18n'
import { getLocale, getProjectId, getWorkspaceId, setActiveProject, setActiveWorkspace } from './lib/api'
import { useProjectsStore } from './stores/projects'
import { useWorkspacesStore } from './stores/workspaces'

declare global {
  interface Window {
    __PINIA__?: Record<string, StateTree>
  }
}

const { app, router, pinia, i18n } = createApp()
// Only the language the server rendered with (`<html lang>`, via getLocale) is
// fetched, alongside the route's own chunks rather than after them.
const messagesReady = ensureLocaleMessages(i18n, getLocale())

if (window.__PINIA__) {
  pinia.state.value = window.__PINIA__
  // The server replaced a workspace the cookie named but the caller cannot see
  // (deleted, #479) with the first one listed. First, because adopting a
  // workspace clears the remembered project the next lines then adopt.
  const workspaces = useWorkspacesStore(pinia)
  const fallback = workspaces.items[0]?.workspaceId
  if (workspaces.loaded && fallback && !workspaces.items.some((w) => w.workspaceId === getWorkspaceId())) {
    setActiveWorkspace(fallback)
  }
  // The server may have resolved the active project against the roster (a
  // remembered one that is gone, or none yet). Adopt what it rendered with,
  // or every API call this page makes would ask for another scope (#279).
  const projects = useProjectsStore(pinia)
  if (projects.loaded && projects.activeId !== getProjectId()) setActiveProject(projects.activeId)
}

Promise.all([router.isReady(), messagesReady]).then(() => {
  app.mount('#app')
})
