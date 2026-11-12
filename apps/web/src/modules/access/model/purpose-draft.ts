import { computed, ref } from 'vue'
import { WORKSPACE_FEATURES, reconcilePurpose, suggestedDisabled, type WorkspaceFeature, type WorkspaceUse } from '@knowledge/contracts'
import { useFeaturesStore } from '@/stores/features'

/**
 * An unsaved purpose and the section list it leads to (#934), shared by
 * Settings → Features and the first-visit wizard. The list is the contracts
 * reconcile over what is stored, with this session's own clicks on top, so
 * ticking another use never undoes a section the admin just set.
 */
export function usePurposeDraft() {
  const features = useFeaturesStore()
  const uses = ref<WorkspaceUse[]>([...features.uses])
  /** Sections clicked in this draft: feature → off. */
  const clicked = ref(new Map<WorkspaceFeature, boolean>())

  /** Off under the draft's uses; `null` while no use is ticked, when a purpose suggests nothing. */
  const suggested = computed(() => (uses.value.length ? suggestedDisabled(uses.value) : null))
  const reconciled = computed(() => reconcilePurpose(features.uses, uses.value, features.disabled).disabled)
  const off = computed(() => WORKSPACE_FEATURES.filter((f) => clicked.value.get(f) ?? reconciled.value.includes(f)))

  function toggle(feature: WorkspaceFeature, on: boolean) {
    clicked.value = new Map(clicked.value).set(feature, !on)
  }
  function reset() {
    uses.value = [...features.uses]
    clicked.value = new Map()
  }
  return { uses, suggested, off, toggle, reset }
}
