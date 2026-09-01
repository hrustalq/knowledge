import { createMemoryHistory, createRouter as createVueRouter, createWebHistory } from 'vue-router'

export function createRouter() {
  return createVueRouter({
    history: import.meta.env.SSR ? createMemoryHistory() : createWebHistory(),
    routes: [
      { path: '/', redirect: '/documents' },
      { path: '/documents', component: () => import('@/pages/DocumentsListPage.vue') },
      { path: '/documents/:id', component: () => import('@/pages/DocumentDetailPage.vue') },
      { path: '/upload', component: () => import('@/pages/UploadPage.vue') },
      { path: '/search', component: () => import('@/pages/SearchPage.vue') },
    ],
  })
}
