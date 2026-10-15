import type {
  Locale,
  PublicShareTreeNode,
  PublicSiteLogo,
  PublicSitePageRef,
  PublicSiteTreeNode,
  PublicSiteVersionRef,
  SiteTheme,
  SiteViewerKind,
} from '@knowledge/contracts'
import { siteHomeDocumentId, sitePagePath } from '@knowledge/contracts/publishing'
import type { PublicHeading } from '@/lib/markdown/public-render.server'

/** A page body as the server rendered it: sanitized, links and assets already rewritten into scope. */
export interface PublicRenderedPage {
  documentId: string
  title: string
  html: string
  headings: PublicHeading[]
  updatedAt: string | null
}

/** A published site's chrome (docs/features/44): everything around the page body. */
export interface PublicSiteChrome {
  id: string
  title: string
  theme: SiteTheme
  /** Already absolute against the reader's API base. */
  logo: PublicSiteLogo
  /** `''` on the site's own host, `/pub/<slug>` in path mode. */
  prefix: string
  version: PublicSiteVersionRef
  versions: PublicSiteVersionRef[]
  /** The top level and the open path's children; the nav loads the rest a level at a time (issue #204). */
  tree: PublicSiteTreeNode[]
  /**
   * Who the API read this as, and how to change it (issue #77 phase 3). The
   * reader offers sign-in only on a site with pages that are not public, and
   * sign-out to anyone signed in.
   */
  viewer: SiteViewerKind
  signInUrl: string | null
  /** The site answers questions (issue #77 phase 3): the header offers Ask. */
  ask: boolean
}

/** The Ask widget's frame (issue #77 phase 3): the site's chrome without its pages. */
export interface PublicSiteWidget {
  id: string
  title: string
  theme: SiteTheme
  logo: PublicSiteLogo
  rootUrl: string
}

/**
 * What one public render hands the browser (docs/features/43, 44). Built on
 * the server by entry-public.ts and hydrated from `window.__KN_PUBLIC__` — the
 * reader never fetches the page again on the client, so this is the whole of
 * what it knows.
 */
export type PublicReaderView =
  | { kind: 'not-found' }
  | { kind: 'site-not-found' }
  | {
      kind: 'site'
      site: PublicSiteChrome
      /** Null: the site exists but nothing answers this path — a 404 inside the site's chrome. */
      page:
        | (PublicRenderedPage & {
            slugPath: string
            /** The same page in other versions, by version slug: the switcher links straight there. */
            alternates: { versionSlug: string; href: string }[]
            /** Neighbours in the whole reading order, which the trimmed tree cannot tell. */
            prev: PublicSitePageRef | null
            next: PublicSitePageRef | null
          })
        | null
    }
  | { kind: 'site-widget'; site: PublicSiteWidget | null }
  | { kind: 'locked'; token: string }
  | {
      kind: 'share'
      token: string
      title: string
      tree: PublicShareTreeNode[]
      treeTruncated: boolean
      expiresAt: string | null
      page: PublicRenderedPage
    }

export interface PublicReaderState {
  locale: Locale
  /** The browser-facing API base (`/api` behind Caddy and the Vite proxy). */
  apiBase: string
  view: PublicReaderView
}

/** The reader URL of a page; the shared page itself is the bare token. */
export function shareHref(token: string, documentId: string | null, rootId: string | null): string {
  return documentId && documentId !== rootId ? `/s/${token}/${documentId}` : `/s/${token}`
}

/**
 * The reader URL of a page of a site. The default version has no segment of
 * its own, and the home page lives at the version root rather than under its
 * own slug, so every page has exactly one URL.
 */
export function siteHref(
  site: Pick<PublicSiteChrome, 'prefix'>,
  version: PublicSiteVersionRef,
  slugPath: string,
  isHome = false,
): string {
  return sitePagePath(site.prefix, version.isDefault ? null : version.slug, isHome ? '' : slugPath)
}

/** The site's home page, by the one rule the API's resolve, sitemap and llms.txt also use. */
export function siteHomeId(tree: PublicSiteTreeNode[]): string | null {
  return siteHomeDocumentId(tree)
}

type TreeNode = Pick<PublicShareTreeNode, 'documentId' | 'parentId' | 'title' | 'position'>

/** The tree as rows in reading order, each with its depth below the top. */
export function treeRows<T extends TreeNode>(nodes: T[]): Array<T & { depth: number }> {
  const children = new Map<string | null, T[]>()
  const ids = new Set(nodes.map((n) => n.documentId))
  for (const node of nodes) {
    // A parent cut off by the tree cap would orphan its children; they are
    // dropped rather than shown at the wrong level.
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : node.parentId === null ? null : undefined
    if (parent === undefined) continue
    const list = children.get(parent) ?? []
    list.push(node)
    children.set(parent, list)
  }
  const rows: Array<T & { depth: number }> = []
  const walk = (parent: string | null, depth: number) => {
    const list = (children.get(parent) ?? []).sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
    for (const node of list) {
      rows.push({ ...node, depth })
      walk(node.documentId, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}
