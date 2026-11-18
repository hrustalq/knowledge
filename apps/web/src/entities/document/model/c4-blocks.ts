import { C4_LANG } from '@/core/markdown/c4-lang'

/** A ```structurizr fence in rendered markup, swapped for an empty host its C4Diagram is teleported into. */
export interface C4Block {
  el: HTMLElement
  source: string
}

/**
 * Every C4 model under `root` (#1244). The fence renders as an ordinary code
 * block, which is what the editor keeps and what a surface without this upgrade
 * shows; a read view replaces each with a host and mounts C4Diagram there.
 */
export function takeC4Blocks(root: Element): C4Block[] {
  return [...root.querySelectorAll<HTMLElement>(`pre > code.language-${C4_LANG}`)].map((code) => {
    const el = document.createElement('div')
    el.className = 'kn-c4-host'
    code.parentElement!.replaceWith(el)
    return { el, source: code.textContent ?? '' }
  })
}
