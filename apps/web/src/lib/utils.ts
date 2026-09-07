import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Unwraps the DOM node from a template ref on a shadcn wrapper whose root *is*
 * the native control (`Input`, `Textarea`). `ref="x"` on a component yields the
 * component instance, so call sites that need `.focus()` or `.selectionStart`
 * go through this:
 *
 *   const el = ref<HTMLInputElement | null>(null)
 *   const setEl = (c: unknown) => { el.value = nativeEl<HTMLInputElement>(c) }
 *   <Input :ref="setEl" />
 */
export function nativeEl<T extends HTMLElement>(instance: unknown): T | null {
  return (instance as { $el?: T } | null)?.$el ?? null
}
