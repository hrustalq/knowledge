import type { Blueprint } from '@knowledge/contracts';
import { page } from './page.js';

/** Code product (#716): product, domain, discovery sessions, architecture, ADRs and gotchas. */
export const CODE_PRODUCT_BLUEPRINT: Blueprint = {
  name: { en: 'Code product', ru: 'Продукт с кодом' },
  description: {
    en: 'For a product built in a repository: why it exists, its domain, how it is built, the decisions behind it and the traps in it.',
    ru: 'Для продукта, который пишется в репозитории: зачем он нужен, его предметная область, устройство, решения и подводные камни.',
  },
  icon: '🛠️',
  tree: [
    page('Product', 'Продукт', {
      guidance: ['Why the product exists and how it gets delivered.', 'Зачем существует продукт и как он доставляется.'],
      children: [
        page('Vision and audience', 'Видение и аудитория'),
        page('Brief', 'Бриф'),
        page('MVP scope', 'Границы MVP'),
        page('Business model', 'Бизнес-модель'),
        page('Delivery plan', 'План поставки', { category: 'process' }),
      ],
    }),
    page('Domain', 'Предметная область', {
      category: 'erd',
      guidance: ['The concepts the code is about, named once.', 'Понятия, с которыми работает код, — названные один раз.'],
      children: [
        page('Domain model', 'Модель предметной области', { category: 'erd' }),
        page('Glossary', 'Глоссарий', { category: 'reference' }),
      ],
    }),
    page('Discovery', 'Исследования', {
      collection: { pattern: ['{{date}} session', '{{date}} сессия'] },
      guidance: ['One page per discovery session: who took part, what was learned.', 'По странице на сессию: кто участвовал и что выяснили.'],
    }),
    page('Architecture', 'Архитектура', {
      category: 'architecture',
      guidance: ['How the system is built, one page per component.', 'Как устроена система — по странице на компонент.'],
      children: [
        page('System overview', 'Обзор системы', { category: 'architecture' }),
        page('Components', 'Компоненты', { category: 'architecture', collection: { template: 'builtin:component' } }),
      ],
    }),
    page('Decisions', 'Решения', {
      category: 'architecture',
      collection: { template: 'builtin:adr', pattern: 'ADR {{n:4}}: ' },
      guidance: ['One architecture decision record per decision, numbered.', 'По одной записи на каждое архитектурное решение, с номером.'],
    }),
    page('Gotchas', 'Подводные камни', {
      category: 'guide',
      collection: {},
      guidance: ['Traps someone already fell into, one page each, with the way out.', 'Ловушки, в которые уже кто-то попадал, — по странице на каждую, с выходом.'],
    }),
  ],
};
