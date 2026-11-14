/**
 * Browser storage that belongs to whoever is signed in, and goes at sign-out
 * (#1101). The keys live here, below the entities that write them, so the
 * auth store can forget them without importing upward.
 */

/** The connector setup wizard's resumable snapshot (entities/connector). Never holds a credential. */
export const CONNECTOR_SETUP_KEY = 'kn_connector_setup'

/** Unpublished page edits, one key per page and branch (entities/rich-editor). */
export const WORKING_COPY_PREFIX = 'kn:unstaged:v1:'

/** Remove every signed-in key. Storage that is missing or throws leaves nothing to forget. */
export function forgetSignedInStorage(): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    const doomed: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key === CONNECTOR_SETUP_KEY || key?.startsWith(WORKING_COPY_PREFIX)) doomed.push(key)
    }
    for (const key of doomed) storage.removeItem(key)
  } catch {
    /* a private window, or storage blocked: nothing was kept */
  }
}
