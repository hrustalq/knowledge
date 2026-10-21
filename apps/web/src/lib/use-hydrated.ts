import { computed, type ComputedRef } from 'vue'
import { useMediaQuery, useMounted } from '@vueuse/core'

/**
 * A media query that answers `false` until the component has mounted.
 *
 * `useMediaQuery` reads false on the server but the real value during the
 * client's setup, so a template that branches on it renders one tree on the
 * server and another in the first client render: a hydration mismatch, and on
 * a phone Vue throws the server's nodes away. Gating on mount makes the first
 * client render equal the server's; the real surface follows one tick later,
 * which nobody sees because every caller branches on something closed.
 */
export function useHydratedMediaQuery(query: string): ComputedRef<boolean> {
  const mounted = useMounted()
  const matches = useMediaQuery(query)
  return computed(() => mounted.value && matches.value)
}
