import { defineStore, type Pinia } from 'pinia'
import type { Directive } from 'vue'
import type { EditingPolicyResponse, HistoryAudience, PublishMode, WorkspaceFeature, WorkspaceFeaturesResponse, WorkspacePurposeResponse, WorkspaceUse } from '@knowledge/contracts'
import { apiQueryOptions, bindStoreQuery } from '@/shared/api/queries'
import { api } from '@/shared/api/client'
import { DEMO_WORKSPACE_ID, getWorkspaceId } from '@/shared/api/api'

const optionsFor = (id: string) => apiQueryOptions('/v1/workspaces/{id}/features', { path: { id } })
const editingOptionsFor = (id: string) => apiQueryOptions('/v1/workspaces/{id}/editing-policy', { path: { id } })

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
    /** What the workspace is used for (#934): advice the sections were suggested from, never a switch. */
    uses: [] as WorkspaceUse[],
    /** False only for a new workspace whose admin has not yet met the purpose question. A failed read leaves it true: no redirect on a blip. */
    purposeAsked: true,
    /** The editing policy (#958), loaded with the sections. Null after a failed read: the getters below then answer the defaults, and the API still enforces the real one. */
    editing: null as EditingPolicyResponse | null,
    loaded: false,
  }),
  getters: {
    isOn: (s) => (feature: WorkspaceFeature): boolean => !s.disabled.includes(feature) && !s.unavailable.includes(feature),
    publishMode: (s): PublishMode => s.editing?.publishMode.effective ?? 'review',
    historyAudience: (s): HistoryAudience => s.editing?.historyAudience.effective ?? 'everyone',
    /** In a `direct` workspace people open no merge requests, so the page lists what agents and captures proposed (#958). */
    proposalsOnly(): boolean {
      return this.publishMode === 'direct'
    },
  },
  actions: {
    async ensureLoaded(): Promise<void> {
      if (this.loaded) return
      const id = getWorkspaceId()
      try {
        if (id) {
          await Promise.all([
            bindStoreQuery<WorkspaceFeaturesResponse>(this, 'features', this.queryClient, optionsFor(id), (res) => this.apply(res)),
            // Its own failure costs only the policy, never the sections.
            bindStoreQuery<EditingPolicyResponse>(this, 'editing', this.queryClient, editingOptionsFor(id), (res) => {
              this.editing = res
            }).catch(() => undefined),
          ])
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
      this.apply(res)
    },
    /** Workspace admin: a key left out is unchanged, null goes back to inheriting. */
    async saveEditing(body: { publishMode?: PublishMode | null; historyAudience?: HistoryAudience | null; requiredApprovals?: number | null }): Promise<void> {
      const id = getWorkspaceId()
      const res = await api.put('/v1/workspaces/{id}/editing-policy', { path: { id }, body })
      this.queryClient.setQueryData(editingOptionsFor(id).queryKey, res)
      this.editing = res
    },
    apply(res: WorkspaceFeaturesResponse) {
      this.disabled = res.disabled
      this.unavailable = res.unavailable ?? []
      this.uses = res.uses ?? []
      // The demo workspace is AUTH_MODE=none's fixture: it has no `workspaces` row for the
      // migration to stamp, and nobody created it, so there is nobody to ask.
      this.purposeAsked = (res.purposeAsked ?? true) || res.workspaceId === DEMO_WORKSPACE_ID
    },
    /** Workspace admin: the stored purpose with its description, which the members' read never carries. */
    loadPurpose(): Promise<WorkspacePurposeResponse> {
      return api.get('/v1/workspaces/{id}/purpose', { path: { id: getWorkspaceId() } })
    },
    /** Workspace admin: the purpose and the confirmed section list in one write; no uses with the list untouched is Skip. */
    async savePurpose(body: { uses: WorkspaceUse[]; description?: string | null; disabled: WorkspaceFeature[] }): Promise<void> {
      const id = getWorkspaceId()
      const res = await api.put('/v1/workspaces/{id}/purpose', { path: { id }, body })
      const next: WorkspaceFeaturesResponse = { workspaceId: id, disabled: res.disabled, unavailable: this.unavailable, uses: res.uses, purposeAsked: true }
      this.queryClient.setQueryData(optionsFor(id).queryKey, next)
      this.apply(next)
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
