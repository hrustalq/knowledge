import { useI18n } from 'vue-i18n'
import { viewTitle, type C4View, type C4ViewType } from '@/core/markdown/structurizr'

/** A view's title in the reader's language: the author's, else `Shop · Containers`. */
export function useC4Levels(): (view: C4View) => string {
  const { t } = useI18n()
  const levels: Record<C4ViewType, () => string> = {
    systemContext: () => t('c4.level.systemContext'),
    container: () => t('c4.level.container'),
    component: () => t('c4.level.component'),
  }
  return (view) => viewTitle(view, (type) => levels[type]())
}
