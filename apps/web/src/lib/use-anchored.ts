import { computed, shallowRef, watch, type Ref } from 'vue'
import { autoUpdate, flip, offset, shift, size, useFloating, type Placement } from '@floating-ui/vue'

/** A viewport-space rectangle to hang a floating element off. */
export interface AnchorRect {
  top: number
  left: number
  width?: number
  height?: number
}

/**
 * Floating UI for elements anchored to a *coordinate* rather than to a DOM
 * trigger — the editor's selection bubble, the table bar, the drag handle.
 *
 * These cannot use the reka Popover: it manages focus and dismissal, and a
 * toolbar that takes focus away from the editor destroys the very selection it
 * is offering to format. So they get the positioning engine on its own:
 *
 * - `flip` moves the element to the other side when it would leave the
 *   viewport (what the hand-rolled `above < ceiling` checks approximated),
 * - `shift` slides it along the cross axis to stay on screen (what none of
 *   them had, which is why they overflowed horizontally),
 * - `size` caps it to the space actually available,
 * - `autoUpdate` keeps it pinned through scroll, resize and layout shifts.
 *
 * Bind the returned `floatingStyles`, and attach the element with
 * `:ref="setFloating"` — a callback ref, because a template unwraps a plain
 * ref object and hands the composable an element instead of the box to put it
 * in. Same reason `ChatComposer` uses `setInputEl`.
 */
export function useAnchoredFloating(
  rect: Ref<AnchorRect | null>,
  options: {
    placement?: Placement
    gap?: number
    padding?: number
    /**
     * `fixed` pins to the viewport (a toolbar for the current selection).
     * `absolute` positions against the offsetParent, so the element scrolls
     * with the content it annotates — which is what an anchor to a passage
     * has to do.
     */
    strategy?: 'fixed' | 'absolute'
  } = {},
) {
  const { placement = 'top', gap = 8, padding = 8, strategy = 'fixed' } = options

  const floating = shallowRef<HTMLElement | null>(null)
  // A Floating UI "virtual element": anything that can report a rect.
  const reference = computed(() => {
    const r = rect.value
    if (!r) return null
    const width = r.width ?? 0
    const height = r.height ?? 0
    return {
      getBoundingClientRect: () =>
        ({
          x: r.left,
          y: r.top,
          width,
          height,
          top: r.top,
          left: r.left,
          right: r.left + width,
          bottom: r.top + height,
        }) as DOMRect,
    }
  })

  const { floatingStyles, update } = useFloating(reference, floating, {
    placement,
    strategy,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(gap),
      flip({ padding }),
      shift({ padding }),
      size({
        padding,
        apply({ availableWidth, availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            maxWidth: `${Math.max(0, availableWidth)}px`,
            maxHeight: `${Math.max(0, availableHeight)}px`,
          })
        },
      }),
    ],
  })

  // The reference is virtual, so autoUpdate has no element to observe for it —
  // recompute whenever the anchor coordinate itself moves.
  watch(rect, () => void update(), { flush: 'post' })

  /** Callback template ref: `:ref="setFloating"`. */
  const setFloating = (el: unknown) => {
    floating.value = (el as { $el?: HTMLElement } | HTMLElement | null) instanceof HTMLElement
      ? (el as HTMLElement)
      : (((el as { $el?: HTMLElement } | null)?.$el as HTMLElement | undefined) ?? null)
  }

  return { floating, setFloating, floatingStyles }
}
