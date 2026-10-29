import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The ramp's own steps (assets/style.css @theme: micro, caption, ui) are font sizes.
// Unregistered, tailwind-merge reads `text-caption` as a text colour and drops
// it from `cn('text-caption', 'text-muted-foreground')`.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ['micro', 'caption', 'ui'] } } })

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
