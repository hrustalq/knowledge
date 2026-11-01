import { defineStore, type Pinia } from 'pinia'
import type { Directive } from 'vue'
import type { WorkspaceFeature, WorkspaceFeaturesResponse } from '@knowledge/contracts'
import { apiQueryOptions, bindStoreQuery } from '@/shared/api/queries'
import { api } from '@/shared/api/client'
import { getWorkspaceId } from '@/shared/api/api'

const optionsFor = (id: string) => apiQueryOptions('/v1/workspaces/{id}/features', { path: { id } })

/**
 * The sections the active workspace switched off (#604). Loaded by the router
 * guard before the first route resolves — on the server too — so the nav, the
 * routes and `v-feature` all draw the first frame from the same answer.
 *
 * A failed read leaves every section on: the API still refuses what is off,
 * and a nav that hid everything on a network blip would be worse.
 */
export const useFeaturesStore = defineStore('features', {
  state: () => ({
    disabled: [] as WorkspaceFeature[],
    /** Off on the server (an env ceiling), whatever `disabled` says. */
    unavailable: [] as WorkspaceFeature[],
    loaded: false,
  }),
  getters: {
    isOn: (s) => (feature: WorkspaceFeature): boolean => !s.disabled.includes(feature) && !s.unavailable.includes(feature),
  },
  actions: {
    async ensureLoaded(): Promise<void> {
      if (this.loaded) return
      const id = getWorkspaceId()
      try {
        if (id) {
          await bindStoreQuery<WorkspaceFeaturesResponse>(this, 'features', this.queryClient, optionsFor(id), (res) => {
            this.disabled = res.disabled
            this.unavailable = res.unavailable ?? []
          })
        }
      } catch {
        // every section stays on; see above
      }
      this.loaded = true
    },
    /** Workspace admin: replace the switched-off list. */
    async save(disabled: WorkspaceFeature[]): Promise<void> {
      const id = getWorkspaceId()
      const res = await api.put('/v1/workspaces/{id}/features', { path: { id }, body: { disabled } })
      this.queryClient.setQueryData(optionsFor(id).queryKey, res)
      this.disabled = res.disabled
      this.unavailable = res.unavailable ?? []
    },
  },
})

/**
 * `v-feature="'analytics'"`: the element is `hidden` while that section is
 * off. Hidden rather than removed so the server renders the same markup the
 * client hydrates; Tailwind's preflight makes `[hidden]` win over a display
 * class. A list built in script filters with `isOn` instead.
 *
 * Built per app with its own Pinia: `getSSRProps` runs outside any component's
 * setup, where `useFeaturesStore()` alone would reach for a shared active store.
 */
export function featureDirective(pinia: Pinia): Directive<HTMLElement, WorkspaceFeature> {
  const off = (feature: WorkspaceFeature) => !useFeaturesStore(pinia).isOn(feature)
  return {
    getSSRProps: (binding) => (off(binding.value) ? { hidden: true } : {}),
    mounted: (el, binding) => {
      el.hidden = off(binding.value)
    },
    updated: (el, binding) => {
      el.hidden = off(binding.value)
    },
  }
}

declare module 'vue' {
  interface GlobalDirectives {
    vFeature: Directive<HTMLElement, WorkspaceFeature>
  }
}
