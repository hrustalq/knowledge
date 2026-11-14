/**
 * Browser storage that belongs to whoever is signed in, and goes at sign-out
 * (#1101, #1142). The keys live here, below the entities and modules that
 * write them, so the auth store can forget them without importing upward.
 */

/** The connector setup wizard's resumable snapshot (entities/connector). Never holds a credential. */
export const CONNECTOR_SETUP_KEY = 'kn_connector_setup'

/** Unpublished page edits, one key per page and branch (entities/rich-editor). */
export const WORKING_COPY_PREFIX = 'kn:unstaged:v1:'

/** The project scaffold and workflow wizards' drafts (modules/projects, modules/workflows). */
export const PROJECT_WIZARD_KEY = 'kn_project_wizard'
export const WORKFLOW_WIZARD_KEY = 'kn_wf_wizard'

/** Try-it values per spec page, third-party credentials included, in sessionStorage (entities/api-operation). */
export const TRY_ENV_PREFIX = 'kn_try:'

const LOCAL_KEYS = new Set([CONNECTOR_SETUP_KEY, PROJECT_WIZARD_KEY, WORKFLOW_WIZARD_KEY])
const forgetters = new Set<() => void>()

/** Run `forget` at sign-out: what a module holds in memory for the signed-in person. */
export function onForgetSignedIn(forget: () => void): void {
  forgetters.add(forget)
}

/** Remove every signed-in key. Storage that is missing or throws leaves nothing to forget. */
export function forgetSignedInStorage(): void {
  removeWhere(() => globalThis.localStorage, (key) => LOCAL_KEYS.has(key) || key.startsWith(WORKING_COPY_PREFIX))
  removeWhere(() => globalThis.sessionStorage, (key) => key.startsWith(TRY_ENV_PREFIX))
  for (const forget of forgetters) forget()
}

function removeWhere(storageOf: () => Storage | undefined, doomed: (key: string) => boolean): void {
  try {
    const storage = storageOf()
    if (!storage) return
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== null && doomed(key)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    /* a private window, or storage blocked: nothing was kept */
  }
}
