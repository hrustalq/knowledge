import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // `fill`: the editor owns the viewport and scrolls its own prose column.
  // Not `bare` (#441): the trail names the project and the page, and the
  // editor's actions stand in the page bar beneath it, where the page
  // view's do — so reading and writing share one chrome stack.
  // `focusWhenShort` (#1062): on a short phone-landscape viewport the top bar
  // and the trail give way, leaving the editor's own bar (Cancel, Publish)
  // and the formatting toolbar above the text.
  {
    path: '/documents/:id/edit',
    component: () => import('./pages/EditorPage.vue'),
    meta: { fill: true, focusWhenShort: true },
  },
  {
    path: '/create',
    component: () => import('./pages/EditorPage.vue'),
    meta: { fill: true, focusWhenShort: true },
  },
  // /upload keeps its path so every existing link, bookmark and sidebar
  // shortcut still lands; /import is the name the flow now goes by.
  // meta.fill: the wizard owns the viewport — its three steps share one
  // frame with a fixed header and action bar, and step 3 holds an editor
  // that scrolls itself. Breadcrumbs stay: unlike the editor this is not a
  // writing surface, and the trail is the only orientation it has.
  {
    path: '/upload',
    alias: '/import',
    component: () => import('./pages/ImportPage.vue'),
    meta: { fill: true },
  },
]
