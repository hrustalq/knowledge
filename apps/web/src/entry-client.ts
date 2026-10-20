import type { StateTree } from 'pinia'
import { createApp } from './main'
import { getProjectId, setActiveProject } from './lib/api'
import { useProjectsStore } from './stores/projects'

declare global {
  interface Window {
    __PINIA__?: Record<string, StateTree>
  }
}

const { app, router, pinia } = createApp()

if (window.__PINIA__) {
  pinia.state.value = window.__PINIA__
  // The server may have resolved the active project against the roster (a
  // remembered one that is gone, or none yet). Adopt what it rendered with,
  // or every API call this page makes would ask for another scope (#279).
  const projects = useProjectsStore(pinia)
  if (projects.loaded && projects.activeId !== getProjectId()) setActiveProject(projects.activeId)
}

router.isReady().then(() => {
  app.mount('#app')
})
