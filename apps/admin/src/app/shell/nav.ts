// The rail's destinations, as data: AppSidebar draws them. The four areas of
// #1235, in rail order.
import type { Component } from 'vue'
import { Activity, SlidersHorizontal, TriangleAlert, Users } from 'lucide-vue-next'

export const NAV_CURRENT = 'bg-primary/10 font-medium text-primary'
export const NAV_IDLE = 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'

export interface NavItem {
  to: string
  labelKey: string
  icon: Component
}

export const SECTION_NAV: NavItem[] = [
  { to: '/config', labelKey: 'admin.nav.config', icon: SlidersHorizontal },
  { to: '/monitoring', labelKey: 'admin.nav.monitoring', icon: Activity },
  { to: '/users', labelKey: 'admin.nav.users', icon: Users },
  { to: '/errors', labelKey: 'admin.nav.errors', icon: TriangleAlert },
]
