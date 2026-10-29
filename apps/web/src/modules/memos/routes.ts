import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // Recordings, transcribed and read against the knowledge base (#551).
  { path: '/memos', component: () => import('./pages/MemosPage.vue') },
  { path: '/memos/:id', component: () => import('./pages/MemoDetailPage.vue') },
]
