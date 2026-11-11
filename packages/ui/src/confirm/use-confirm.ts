import { shallowRef } from 'vue'

/**
 * The one confirmation: `await confirm({ … })` in place of `window.confirm`.
 *
 * A native confirm cannot be translated with the rest of the product, cannot
 * say which button destroys something, and blocks the whole tab. This keeps the
 * one-line call site a native confirm had — a guard that reads
 * `if (!(await confirm(…))) return` — and draws the AlertDialog every hand-built
 * confirmation in the app already uses. A dialog that has to say more than a
 * sentence (DeleteProjectDialog: a destination, counts, a typed name) is still
 * its own component; this is for the yes/no.
 *
 * The state is module-level because ConfirmDialog is mounted once, in App.vue.
 * That is safe under SSR only because nothing asks for a confirmation during a
 * render: every call comes from a click on the client.
 */
export interface ConfirmOptions {
  title: string
  description?: string
  /** The action's own verb ("Revoke", "Remove") — never a bare "OK". */
  action: string
  /** The way out, when "Cancel" would read as the action itself. */
  cancel?: string
  /** Draws the action as destructive. */
  destructive?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

export const pendingConfirm = shallowRef<PendingConfirm | null>(null)

export function confirm(options: ConfirmOptions): Promise<boolean> {
  // A second ask while one is open answers the first with "no" rather than
  // leaving its caller awaiting forever.
  pendingConfirm.value?.resolve(false)
  return new Promise((resolve) => {
    pendingConfirm.value = { ...options, resolve }
  })
}

/** Settles the open confirmation, once; the dialog calls this on every way out. */
export function settleConfirm(ok: boolean) {
  const pending = pendingConfirm.value
  if (!pending) return
  pendingConfirm.value = null
  pending.resolve(ok)
}
