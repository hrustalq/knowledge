import type { StateTree } from 'pinia'
import { createApp } from './main'
import { ensureLocaleMessages } from './i18n'
import { getLocale, getProjectId, setActiveProject } from './lib/api'
import { useProjectsStore } from './stores/projects'

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
  // The server may have resolved the active project against the roster (a
  // remembered one that is gone, or none yet). Adopt what it rendered with,
  // or every API call this page makes would ask for another scope (#279).
  const projects = useProjectsStore(pinia)
  if (projects.loaded && projects.activeId !== getProjectId()) setActiveProject(projects.activeId)
}

Promise.all([router.isReady(), messagesReady]).then(() => {
  app.mount('#app')
})
