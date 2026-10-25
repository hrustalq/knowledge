// The service worker's page half (#472, src/sw.ts): register it, offer a new
// build when one is waiting, and say so while the network is gone.
import { watch } from 'vue'
import { useOnline } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { registerSW } from 'virtual:pwa-register'

// A tab that stays open never navigates, so the browser would not look for a
// new build by itself.
const UPDATE_CHECK_MS = 60 * 60 * 1000

/** Once, from the member app's root component after it mounts. */
export function startPwa(t: (key: string) => string) {
  watch(
    useOnline(),
    (online) => {
      if (online) toast.dismiss('pwa-offline')
      else toast.warning(t('pwa.offline'), { id: 'pwa-offline', description: t('pwa.offlineDescription'), duration: Infinity })
    },
    { immediate: true },
  )

  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast.info(t('pwa.updateReady'), {
        id: 'pwa-update',
        description: t('pwa.updateDescription'),
        duration: Infinity,
        action: { label: t('pwa.reload'), onClick: () => void update() },
      })
    },
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update(), UPDATE_CHECK_MS)
    },
  })
}

/**
 * Logout: the worker's caches go with the session, and so does the worker —
 * the next full page load installs it again with a fresh precache, offline
 * page included.
 */
export async function clearPwaCaches() {
  if (typeof caches === 'undefined') return
  await Promise.all((await caches.keys()).map((key) => caches.delete(key)))
  const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? []
  await Promise.all(registrations.map((r) => r.unregister()))
}
