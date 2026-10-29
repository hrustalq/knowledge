import { defineAsyncComponent } from 'vue'

// The page view renders one of these only for a spec or a test-fixture page, so each loads on first use.
export const ApiReferenceView = defineAsyncComponent(() => import('./ApiReferenceView.vue'))
export const TestFixtureView = defineAsyncComponent(() => import('./TestFixtureView.vue'))
