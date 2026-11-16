// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, markRaw, type ComputedRef } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createI18nFor } from '@/shared/i18n'
import { useCrumbs, type Crumb } from './breadcrumbs'

describe('useCrumbs', () => {
  it('keeps the new workflow wizard trail-less', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/settings/workflows/new', component: { template: '<div />' } }],
    })
    await router.push('/settings/workflows/new')
    await router.isReady()

    const queryClient = new QueryClient()
    const pinia = createPinia()
    pinia.use(() => ({ queryClient: markRaw(queryClient) }))
    let crumbs: ComputedRef<Crumb[]> | undefined
    const app = createApp(
      defineComponent({
        setup() {
          crumbs = useCrumbs()
          return () => h('div')
        },
      }),
    )
    app.use(pinia)
    app.use(router)
    app.use(createI18nFor('en'))
    app.use(VueQueryPlugin, { queryClient })
    app.mount(document.createElement('div'))

    expect(crumbs!.value).toEqual([])
    app.unmount()
  })
})
