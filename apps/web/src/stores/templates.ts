import { defineStore } from 'pinia'
import {
  parseTemplateRef,
  type ListTemplatesResponse,
  type RenderTemplateResponse,
  type TemplateDetail,
  type TemplateRef,
  type TemplateSummary,
} from '@knowledge/contracts'
import { apiQueryOptions, bindStoreQuery, fetchApi, unbindStoreQuery } from '@/api/queries'
import { getProjectId, getWorkspaceId } from '@/lib/api'
import { offeredTemplates } from '@/lib/templates'

/** Where a page started from the gallery goes. */
export interface GalleryTarget {
  /**
   * `create` opens the editor on a new page; `insert` (the editor's
   * `/template`) hands the render back to the page being written instead.
   */
  mode?: 'create' | 'insert'
  /** Preselect this template, e.g. when the editor could not render it without values. */
  ref?: TemplateRef
  parentId?: string | null
  projectId?: string | null
  /** Insert mode: the page's title as it stands — the `{{title}}` a section is rendered with. */
  title?: string
}

/** A fill the gallery asked for, waiting for the editor it navigates to. */
export interface TemplateFill {
  ref: TemplateRef
  prompt: string
}

/**
 * Where an insert-mode render goes. Outside the store's state on purpose: a
 * callback is not state, and state is what SSR serializes.
 */
let insertHandler: ((rendered: RenderTemplateResponse) => void) | null = null

/**
 * The page templates available in the active project (issue #69), and the
 * gallery that offers them.
 *
 * Project-scoped for the reason the workflow roster is: a template may belong
 * to one project, and offering it under another would start that project's
 * pages there. `rescope()` is called from the projects store beside the
 * glossary's and the workflows'.
 *
 * The roster includes archived templates and hidden built-ins, because a page
 * created from one still names it ("From template: ADR v3"); `offered` is
 * what the gallery may start a page from.
 *
 * The gallery is opened from places that know nothing of each other — the
 * tree's `+`, a row's menu, the editor when a link arrives without values —
 * so its open state lives here and the dialog is mounted once, in AppShell.
 */
export const useTemplatesStore = defineStore('templates', {
  state: () => ({
    templates: [] as TemplateSummary[],
    loaded: false,
    /**
     * In-flight fetch, so concurrent consumers share one request. Client-only:
     * a Promise serializes to `{}`, so a store whose SSR pass started a fetch
     * would hydrate believing one is still running, and never load. Call
     * `ensureLoaded` from a mount hook or a user action, never from setup.
     */
    pending: null as Promise<void> | null,
    gallery: { open: false, target: {} as GalleryTarget },
    /**
     * A render the gallery already made, handed to the editor it navigates to.
     * Transient: a reload or a pasted link has none, and the editor renders
     * the template itself.
     */
    rendered: null as RenderTemplateResponse | null,
    /**
     * "Describe the page for AI": what the author asked for, handed to the
     * editor with the render, which opens the assistant on it as the first
     * turn. Transient and one-shot for the same reason as `rendered` — a
     * reload must not ask the assistant again.
     */
    fill: null as TemplateFill | null,
  }),
  getters: {
    offered(state): TemplateSummary[] {
      return offeredTemplates(state.templates)
    },
    byRef(state): (ref: string | null | undefined) => TemplateSummary | undefined {
      return (ref) => (ref ? state.templates.find((t) => t.ref === ref) : undefined)
    },
  },
  actions: {
    async ensureLoaded() {
      if (this.loaded) return
      if (this.pending) return this.pending
      this.pending = this.fetchList().finally(() => (this.pending = null))
      return this.pending
    },
    async fetchList(fresh = false) {
      try {
        // No active project yet means "the whole workspace", the same fallback
        // the documents store uses.
        const projectId = getProjectId()
        await bindStoreQuery<ListTemplatesResponse>(
          this,
          'list',
          this.queryClient,
          apiQueryOptions('/v1/templates', {
            query: { workspaceId: getWorkspaceId(), includeArchived: true, ...(projectId ? { projectId } : {}) },
          }),
          (res) => {
            this.templates = res.templates
          },
          { fresh },
        )
      } catch {
        // Starting blank still works; the gallery says it has nothing to offer.
        this.templates = []
      }
      this.loaded = true
    },
    async refresh() {
      this.loaded = false
      this.pending = this.fetchList(true).finally(() => (this.pending = null))
      await this.pending
    },
    /**
     * Project switch: drop the roster at once — offering the old project's
     * templates under the new one is worse than offering none — and refetch
     * only if something was already using it.
     */
    async rescope() {
      const wanted = this.loaded
      unbindStoreQuery(this, 'list')
      this.templates = []
      this.loaded = false
      if (wanted) await this.ensureLoaded()
    },

    /** One template with its body and placeholders, at a version or the current one. */
    async detail(ref: TemplateRef, version?: number): Promise<TemplateDetail> {
      const parsed = parseTemplateRef(ref)
      if (!parsed) throw new Error(`Unknown template ${ref}`)
      const v = version ? { version } : {}
      return (await (parsed.kind === 'builtin'
        ? fetchApi(this.queryClient, '/v1/templates/built-in/{key}', { path: { key: parsed.key }, query: { workspaceId: getWorkspaceId(), ...v } })
        : fetchApi(this.queryClient, '/v1/templates/{id}', { path: { id: parsed.id }, query: v }))) as TemplateDetail
    },

    openGallery(target: GalleryTarget = {}) {
      insertHandler = null
      this.gallery = { open: true, target: { ...target, mode: 'create' } }
    },
    /** The gallery in insert mode: `onInsert` receives the render, and nothing navigates. */
    openInsertGallery(target: Omit<GalleryTarget, 'mode'>, onInsert: (rendered: RenderTemplateResponse) => void) {
      insertHandler = onInsert
      this.gallery = { open: true, target: { ...target, mode: 'insert' } }
    },
    closeGallery() {
      this.gallery.open = false
    },
    /** Hand an insert-mode render to whoever opened the gallery, once. */
    deliverInsert(rendered: RenderTemplateResponse): boolean {
      const handler = insertHandler
      insertHandler = null
      handler?.(rendered)
      return handler !== null
    },
    /** The gallery's fill request for `ref`, once — taken with its render. */
    takeFill(ref: TemplateRef): string | null {
      const fill = this.fill
      this.fill = null
      return fill?.ref === ref ? fill.prompt : null
    },
    /** The gallery's render for `ref`, once: a second editor visit must not reuse it. */
    takeRendered(ref: TemplateRef): RenderTemplateResponse | null {
      const rendered = this.rendered
      this.rendered = null
      return rendered?.templateRef === ref ? rendered : null
    },
  },
})
